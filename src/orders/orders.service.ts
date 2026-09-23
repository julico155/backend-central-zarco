import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, sql, Transaction } from 'kysely';
import { AppConfig } from '../config/configuration';
import { KYSELY } from '../database/database.module';
import {
  Database,
  OrderChannel,
  OrderDeliveryType,
  OrderPaymentMethod,
  OrderPaymentStatus,
  OrderPromotionComponentSnapshot,
  OrderStatus,
} from '../database/types';
import {
  DomainException,
  InvalidStateTransitionError,
  NotFoundDomainError,
  ProductUnavailableError,
  PromotionUnavailableError,
  StoreClosedError,
  ValidationError,
} from '../common/exceptions/domain-exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { checkoutGateAt, lateRequestExpiryFor } from '../common/time/service-window';
import { OperationalSettingsService } from '../operational-settings/operational-settings.service';
import { DeliveryService } from '../delivery/delivery.service';
import { NotificationsOutService } from '../notifications-out/notifications-out.service';
import { CashRegisterService } from '../cash-register/cash-register.service';
import { QrPaymentsService } from '../bank-qr/qr-payments.service';
import { CreateOrderDto } from './dto/create-order.dto';

export interface OrderItemResponse {
  productId: string;
  productCodeSnapshot: string;
  productNameSnapshot: string;
  unitPriceSnapshot: number;
  quantity: number;
  subtotal: number;
  excludedComplements: string[];
}

export interface OrderPromotionResponse {
  promotionId: string | null;
  promotionNameSnapshot: string;
  promoPriceSnapshot: number;
  comboQuantity: number;
  subtotal: number;
  componentsSnapshot: OrderPromotionComponentSnapshot[];
}

export interface OrderResponse {
  id: string;
  orderNumber: string;
  customerId: string | null;
  channel: string;
  customerName: string;
  deliveryType: string;
  paymentMethod: string;
  paymentStatus: string;
  status: string;
  notes: string | null;
  subtotalAmount: number;
  deliveryBaseAmount: number;
  deliverySurchargeAmount: number;
  totalAmount: number;
  deliveryQuoteStatus: string | null;
  deliveryDistanceMeters: number | null;
  cashConfirmedAt: string | null;
  /** Solo con paymentMethod='split'. */
  splitCashAmount: number | null;
  splitQrAmount: number | null;
  splitCashConfirmedAt: string | null;
  statusUpdatedBy: string | null;
  createdAt: string;
  items: OrderItemResponse[];
  /** Combos vendidos. `items` solo trae los productos sueltos, así que sin esto el ticket y el tablero de cocina quedan incompletos. */
  promotions: OrderPromotionResponse[];
}

export interface LateOrderRequestAcceptedResponse {
  requestId: string;
  requestNumber: string;
  status: 'pending';
  subtotalAmount: number;
  expiresAt: string;
}

export type CreateOrderOutcome =
  | { httpStatus: 200 | 201; body: OrderResponse }
  | { httpStatus: 202; body: LateOrderRequestAcceptedResponse };

export interface CheckoutCartInput {
  customerId: string | null;
  channel: OrderChannel;
  customerName: string;
  deliveryType: OrderDeliveryType;
  paymentMethod: OrderPaymentMethod;
  notes: string | null;
  items: { productId: string; quantity: number; excludedComplements?: string[] }[];
  promotions: { promotionId: string; quantity: number; revision: number }[];
  /** Solo lo pasa LateOrderRequestsService.accept() — un pedido normal nace sin caja, se vincula recién al cobrarse. */
  registerSessionId?: string | null;
}

const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  draft: ['awaiting_location', 'confirmed', 'cancelled'],
  awaiting_location: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['out_for_delivery', 'delivered', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

/**
 * Corazón del sistema. Porta `create_order_web_v5` (saas_smarky,
 * `0029_promotions.sql`) al esquema nuevo: sin `menu_sessions` (el
 * `Idempotency-Key` genérico reemplaza sesión+fingerprint) y con
 * products/categories en vez de menu_items con enum.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly idempotency: IdempotencyService,
    private readonly operationalSettings: OperationalSettingsService,
    private readonly deliveryService: DeliveryService,
    private readonly notifications: NotificationsOutService,
    private readonly cashRegister: CashRegisterService,
    private readonly qrPayments: QrPaymentsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async findById(id: string): Promise<OrderResponse> {
    const order = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!order) throw new NotFoundDomainError('order', id);
    const { items, promotions } = await loadOrderLines(this.db, id);
    return toOrderResponse(order, items, promotions);
  }

  async findMany(filter: {
    customerId?: string;
    status?: OrderStatus;
    deliveryType?: OrderDeliveryType;
    paymentStatus?: OrderPaymentStatus;
    channel?: OrderChannel;
    limit?: number;
    offset?: number;
  }): Promise<OrderResponse[]> {
    let query = this.db.selectFrom('orders').selectAll();
    if (filter.channel) query = query.where('channel', '=', filter.channel);
    if (filter.customerId) query = query.where('customer_id', '=', filter.customerId);
    if (filter.status) query = query.where('status', '=', filter.status);
    if (filter.deliveryType) query = query.where('delivery_type', '=', filter.deliveryType);
    if (filter.paymentStatus) query = query.where('payment_status', '=', filter.paymentStatus);
    const orders = await query
      .orderBy('created_at', 'desc')
      .limit(Math.min(filter.limit ?? 50, 200))
      .offset(filter.offset ?? 0)
      .execute();
    if (orders.length === 0) return [];

    const orderIds = orders.map((o) => o.id);
    const items = await this.db
      .selectFrom('order_items')
      .selectAll()
      .where('order_id', 'in', orderIds)
      .execute();
    const promotions = await this.db
      .selectFrom('order_promotions')
      .selectAll()
      .where('order_id', 'in', orderIds)
      .execute();

    const itemsByOrder = groupByOrderId(items);
    const promotionsByOrder = groupByOrderId(promotions);
    return orders.map((order) =>
      toOrderResponse(
        order,
        itemsByOrder.get(order.id) ?? [],
        promotionsByOrder.get(order.id) ?? [],
      ),
    );
  }

  /**
   * POST /orders. Gate de horario evaluado ANTES que todo lo demás
   * (invariante 7): afuera del margen horario -> 409 cerrado; adentro, la
   * caja decide (ver checkoutGateAt) -> sin caja abierta, 202 +
   * late_order_requests (no consume la Idempotency-Key genérica, usa la
   * suya propia como columna única, igual que delivery_quote_requests).
   * `bypassHoursGate` solo se honra para channel='pos' (decisión de
   * producto — POS puede vender fuera del horario de delivery de WhatsApp,
   * y de la caja: el mostrador vende sin necesitar sesión de caja abierta
   * para simplemente CREAR el pedido, aunque cobrarlo sí la va a exigir).
   */
  async create(
    dto: CreateOrderDto,
    idempotencyKey: string,
    apiClient: string,
  ): Promise<CreateOrderOutcome> {
    const settings = await this.operationalSettings.getRow();
    const now = new Date();
    const bypassAllowed = dto.bypassHoursGate === true && dto.channel === 'pos';
    const gate = bypassAllowed
      ? ({ gate: 'proceed' } as const)
      : checkoutGateAt(
          now,
          { opensHour: settings.business_opens_hour, closesHour: settings.business_closes_hour },
          await this.cashRegister.isOpen(),
        );

    if (gate.gate === 'closed') {
      throw new StoreClosedError();
    }

    if (gate.gate === 'late_review') {
      const body = await this.createLateOrderRequest(dto, idempotencyKey, now);
      return { httpStatus: 202, body };
    }

    const outcome = await this.idempotency.run({
      apiClient,
      endpoint: 'POST /orders',
      idempotencyKey,
      requestBody: dto,
      execute: (trx) => this.executeCreateOrder(trx, dto),
    });

    // Fuera de la transacción a propósito: notifyOrderCreated hace una
    // lectura propia del pedido (otra conexión) y, para QR, una llamada HTTP
    // al banco — si corriera adentro del trx de arriba, la lectura no vería
    // el INSERT todavía sin commitear ("order no existe"), y la llamada
    // externa quedaría sosteniendo la transacción abierta. Solo en una
    // creación real (no en una respuesta cacheada de un reintento).
    if (outcome.created) {
      this.notifyOrderCreated(outcome.body).catch((error: Error) =>
        this.logger.warn(`notifyOrderCreated falló para ${outcome.body.id}: ${error.message}`),
      );
    }

    return { httpStatus: outcome.created ? 201 : 200, body: outcome.body };
  }

  private async notifyOrderCreated(order: OrderResponse): Promise<void> {
    if (!order.customerId) return;

    try {
      await this.notifications.notifyNow({
        channel: 'whatsapp',
        kind: 'order_received',
        targetRef: order.id,
        payload: {
          customerId: order.customerId,
          text: `Recibimos tu pedido ${order.orderNumber}.`,
        },
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo notificar order_received para ${order.id}: ${(error as Error).message}`,
      );
    }

    // El external_message_id de ESTE envío es lo que PaymentProofsService
    // usa para "reply_to_qr" (invariante de asociación nivel 1) — se sigue
    // mandando bajo el mismo kind 'qr_confirmation' así ese matching no se
    // toca, cambia solo el contenido: ahora manda el QR real del banco en
    // vez de pedir una captura. Si el banco falla, cae al texto de pedir
    // captura como estaba antes (fallback, no rompe la creación del pedido).
    const posManualMode =
      order.channel === 'pos' && this.config.get('posQrMode', { infer: true }) === 'manual';

    if (order.paymentMethod === 'qr' && !posManualMode) {
      let payload: { customerId: string; text: string; imageUrl?: string };
      try {
        const charge = await this.qrPayments.generateForOrder(order.id);
        payload = {
          customerId: order.customerId,
          // subtotalAmount, no totalAmount: el QR cobra solo la comida —
          // el envío (si es delivery) se lo paga al repartidor al entregar.
          text: `Tu pedido ${order.orderNumber} es Bs ${order.subtotalAmount.toFixed(2)}. Escaneá el QR para pagar.`,
          imageUrl: charge.qrImageUrl,
        };
      } catch (error) {
        this.logger.warn(
          `No se pudo generar el QR real para ${order.id}, cae a texto: ${(error as Error).message}`,
        );
        payload = {
          customerId: order.customerId,
          text: `Tu pedido ${order.orderNumber} es Bs ${order.subtotalAmount.toFixed(2)}. Cuando pagues, responde a este mensaje con la captura.`,
        };
      }
      try {
        await this.notifications.notifyNow({
          channel: 'whatsapp',
          kind: 'qr_confirmation',
          targetRef: order.id,
          payload,
        });
      } catch (error) {
        this.logger.warn(
          `No se pudo notificar qr_confirmation para ${order.id}: ${(error as Error).message}`,
        );
      }
    }
  }

  /**
   * order_number reinicia con cada apertura de caja (no cada día calendario
   * — el turno cruza medianoche), así que se ancla a la sesión de caja más
   * reciente por `opened_at`, esté abierta o ya cerrada: los pedidos creados
   * en el hueco entre un cierre y la siguiente apertura siguen sumando al
   * contador de la sesión anterior, y recién el próximo "abrir caja" lo
   * vuelve a poner en 1. El incremento atómico (`UPDATE ... RETURNING`)
   * dentro de la misma transacción del pedido serializa contra cualquier
   * otro pedido creándose al mismo tiempo — nunca dos pedidos de la misma
   * sesión con el mismo número.
   */
  private async assignOrderNumber(
    trx: Transaction<Database>,
  ): Promise<{ orderNumber: string; numberingSessionId: string | null }> {
    const latestSession = await trx
      .selectFrom('cash_register_sessions')
      .select('id')
      .orderBy('opened_at', 'desc')
      .limit(1)
      .executeTakeFirst();

    if (!latestSession) {
      // Caso borde: todavía nunca se abrió una caja (arranque del local).
      // Cae al viejo contador global, sin sesión que lo ancle.
      const fallback = await sql<{ nextval: string }>`
        select nextval('order_number_seq') as nextval
      `.execute(trx);
      const n = Number(fallback.rows[0].nextval);
      return { orderNumber: `ORD-${String(n).padStart(4, '0')}`, numberingSessionId: null };
    }

    const updated = await trx
      .updateTable('cash_register_sessions')
      .set({ next_order_number: sql`next_order_number + 1` })
      .where('id', '=', latestSession.id)
      .returning('next_order_number')
      .executeTakeFirstOrThrow();

    return {
      orderNumber: `ORD-${String(updated.next_order_number).padStart(4, '0')}`,
      numberingSessionId: latestSession.id,
    };
  }

  private async executeCreateOrder(
    trx: Transaction<Database>,
    dto: CreateOrderDto,
  ): Promise<{ status: number; body: OrderResponse }> {
    const order = await this.createOrderInTransaction(trx, {
      customerId: dto.customerId ?? null,
      channel: dto.channel,
      customerName: dto.customerName,
      deliveryType: dto.deliveryType,
      paymentMethod: dto.paymentMethod,
      notes: dto.notes ?? null,
      items: dto.items,
      promotions: (dto.promotions ?? []).map((p) => ({
        promotionId: p.promotionId,
        quantity: p.quantity,
        revision: p.revision,
      })),
    });

    return { status: 201, body: order };
  }

  /**
   * Núcleo transaccional del checkout, reusado tanto por `create()` como por
   * `LateOrderRequestsService.accept()` (que lo llama dentro de su propia
   * transacción bloqueando la solicitud primero). Nunca se llama fuera de
   * una transacción real: todos los locks (`for share`) solo tienen sentido
   * ahí dentro.
   */
  async createOrderInTransaction(
    trx: Transaction<Database>,
    input: CheckoutCartInput,
  ): Promise<OrderResponse> {
    const items = input.items;
    const promotions = input.promotions;

    if (items.length > 20) {
      throw new ValidationError('El carrito admite como máximo 20 productos sueltos.');
    }
    if (promotions.length > 10) {
      throw new ValidationError('El carrito admite como máximo 10 promociones.');
    }
    if (items.length + promotions.length < 1) {
      throw new ValidationError('El carrito está vacío.');
    }

    const customerName = input.customerName.trim();
    if (!customerName || customerName.length > 100) {
      throw new ValidationError('customerName debe tener entre 1 y 100 caracteres.');
    }

    const notes = input.notes?.trim() || null;
    if (notes && notes.length > 500) {
      throw new ValidationError('notes admite como máximo 500 caracteres.');
    }

    const productIds = items.map((i) => i.productId);
    // Dos líneas del mismo producto son válidas si tienen distinta selección
    // de complementos (ej. "sin quirquiña" en una sola unidad) — lo que no
    // vale es repetir exactamente la misma combinación en dos líneas, eso
    // debería ser una sola línea con más quantity.
    const itemLineKeys = items.map((i) => `${i.productId}::${complementsKey(i.excludedComplements)}`);
    if (new Set(itemLineKeys).size !== itemLineKeys.length) {
      throw new ValidationError(
        'El carrito tiene líneas duplicadas (mismo producto y misma selección de complementos). Sumá la cantidad en una sola línea en vez de repetirla.',
      );
    }
    const promotionIds = promotions.map((p) => p.promotionId);
    if (new Set(promotionIds).size !== promotionIds.length) {
      throw new ValidationError('El carrito tiene promociones duplicadas.');
    }

    if (input.customerId) {
      const customer = await trx
        .selectFrom('customers')
        .select('id')
        .where('id', '=', input.customerId)
        .executeTakeFirst();
      if (!customer) throw new NotFoundDomainError('customer', input.customerId);
    }

    // El reloj de la base, no el del proceso: la vigencia de promociones se
    // compara contra now() de Postgres, en la misma transacción que escribe.
    const nowRow = await sql<{ now: Date }>`select now() as "now"`.execute(trx);
    const now = nowRow.rows[0].now;

    // Lock de promotions (for share, id ascendente).
    const sortedPromotionIds = [...promotionIds].sort();
    const promotionRows =
      sortedPromotionIds.length > 0
        ? await trx
            .selectFrom('promotions')
            .selectAll()
            .where('id', 'in', sortedPromotionIds)
            .orderBy('id', 'asc')
            .forShare()
            .execute()
        : [];
    const promotionById = new Map(promotionRows.map((p) => [p.id, p]));

    const badPromotionIds = new Set<string>();
    for (const p of promotions) {
      const row = promotionById.get(p.promotionId);
      if (
        !row ||
        row.archived_at !== null ||
        row.is_active !== true ||
        (row.starts_at !== null && new Date(row.starts_at) > now) ||
        (row.ends_at !== null && new Date(row.ends_at) <= now) ||
        row.revision !== p.revision
      ) {
        badPromotionIds.add(p.promotionId);
      }
    }

    // Unión de productos sueltos + componentes de combo, lock for share, id asc.
    const promotionComponents =
      promotionIds.length > 0
        ? await trx
            .selectFrom('promotion_items')
            .selectAll()
            .where('promotion_id', 'in', promotionIds)
            .execute()
        : [];

    const allProductIds = Array.from(
      new Set([...productIds, ...promotionComponents.map((c) => c.product_id)]),
    ).sort();

    const productRows =
      allProductIds.length > 0
        ? await trx
            .selectFrom('products')
            .selectAll()
            .where('id', 'in', allProductIds)
            .orderBy('id', 'asc')
            .forShare()
            .execute()
        : [];
    const productById = new Map(productRows.map((p) => [p.id, p]));

    // Un complemento a excluir tiene que existir en EL PRODUCTO de esa
    // línea puntual — no vale mandar "sin quirquiña" para un producto que
    // no tiene quirquiña en su lista.
    const itemsWithComplements = items.filter((i) => (i.excludedComplements ?? []).length > 0);
    if (itemsWithComplements.length > 0) {
      const complementRows = await trx
        .selectFrom('product_complements')
        .select(['product_id', 'name'])
        .where(
          'product_id',
          'in',
          itemsWithComplements.map((i) => i.productId),
        )
        .execute();
      const validNamesByProduct = new Map<string, Set<string>>();
      for (const row of complementRows) {
        const set = validNamesByProduct.get(row.product_id) ?? new Set<string>();
        set.add(row.name);
        validNamesByProduct.set(row.product_id, set);
      }
      for (const item of itemsWithComplements) {
        const validNames = validNamesByProduct.get(item.productId) ?? new Set<string>();
        const unknown = (item.excludedComplements ?? []).find((name) => !validNames.has(name));
        if (unknown !== undefined) {
          throw new DomainException(
            'unknown_complement',
            HttpStatus.BAD_REQUEST,
            `El producto no tiene un complemento llamado "${unknown}".`,
            { productId: item.productId, complement: unknown },
          );
        }
      }
    }

    const inactiveProductIds = new Set<string>();
    const soldOutProductIds = new Set<string>();
    for (const id of allProductIds) {
      const row = productById.get(id);
      if (!row || row.is_active !== true) inactiveProductIds.add(id);
      else if (row.is_available !== true) soldOutProductIds.add(id);
    }

    // Rechazos de productos SUELTOS únicamente — un componente caído de un
    // combo tiña la promoción (P1005), no produce un rechazo de producto.
    const inactiveLooseItem = items.find((i) => inactiveProductIds.has(i.productId));
    if (inactiveLooseItem) {
      throw new ProductUnavailableError(inactiveLooseItem.productId, 'inactive');
    }
    const soldOutLooseItemIds = items
      .filter((i) => soldOutProductIds.has(i.productId))
      .map((i) => i.productId);
    if (soldOutLooseItemIds.length > 0) {
      throw new ProductUnavailableError(soldOutLooseItemIds[0], 'sold_out', soldOutLooseItemIds);
    }

    // Promociones con algún componente caído.
    for (const comp of promotionComponents) {
      if (inactiveProductIds.has(comp.product_id) || soldOutProductIds.has(comp.product_id)) {
        badPromotionIds.add(comp.promotion_id);
      }
    }

    // Promociones que ya NO ahorran (regla del dinero revalidada al cobrar).
    const componentsByPromotion = new Map<string, { product_id: string; quantity: number }[]>();
    for (const c of promotionComponents) {
      const list = componentsByPromotion.get(c.promotion_id) ?? [];
      list.push(c);
      componentsByPromotion.set(c.promotion_id, list);
    }
    for (const [promotionId, comps] of componentsByPromotion) {
      const promo = promotionById.get(promotionId);
      if (!promo) continue; // ya está en badPromotionIds por "no encontrada"
      const regularTotal = comps.reduce(
        (sum, c) => sum + Number(productById.get(c.product_id)?.price ?? 0) * c.quantity,
        0,
      );
      if (regularTotal <= Number(promo.promo_price)) badPromotionIds.add(promotionId);
    }

    if (badPromotionIds.size > 0) {
      const list = [...badPromotionIds];
      throw new PromotionUnavailableError(list[0], 'unavailable', list);
    }

    // CÁLCULO. Todo desde la base, nada del cliente.
    let subtotal = 0;
    const itemLines = items.map((i) => {
      const product = productById.get(i.productId)!;
      const lineSubtotal = Number(product.price) * i.quantity;
      subtotal += lineSubtotal;
      return {
        product,
        quantity: i.quantity,
        subtotal: lineSubtotal,
        excludedComplements: i.excludedComplements ?? [],
      };
    });

    const promotionLines = promotions.map((p) => {
      const promo = promotionById.get(p.promotionId)!;
      const lineSubtotal = Number(promo.promo_price) * p.quantity;
      subtotal += lineSubtotal;
      const comps = componentsByPromotion.get(p.promotionId) ?? [];
      const componentsSnapshot = comps.map((c) => {
        const product = productById.get(c.product_id)!;
        return {
          productId: product.id,
          code: product.code,
          name: product.name,
          unitPrice: Number(product.price),
          quantity: c.quantity,
        };
      });
      return { promo, quantity: p.quantity, subtotal: lineSubtotal, componentsSnapshot };
    });

    if (subtotal <= 0) {
      throw new ValidationError('El total del pedido debe ser positivo.');
    }

    // pickup (para llevar) y dine_in (mesa) no necesitan ubicación ni cotización: nacen confirmados.
    const needsDelivery = input.deliveryType === 'delivery';
    const initialStatus: OrderStatus = needsDelivery ? 'awaiting_location' : 'confirmed';
    const confirmedAt = needsDelivery ? null : now;
    const deliveryPricing = needsDelivery ? ('dynamic' as const) : null;
    const deliveryQuoteStatus = needsDelivery ? ('pending' as const) : null;

    const { orderNumber, numberingSessionId } = await this.assignOrderNumber(trx);

    const orderRow = await trx
      .insertInto('orders')
      .values({
        order_number: orderNumber,
        numbering_session_id: numberingSessionId,
        customer_id: input.customerId,
        channel: input.channel,
        customer_name: customerName,
        delivery_type: input.deliveryType,
        payment_method: input.paymentMethod,
        notes,
        status: initialStatus,
        subtotal_amount: subtotal.toFixed(2),
        total_amount: subtotal.toFixed(2),
        delivery_pricing: deliveryPricing,
        delivery_quote_status: deliveryQuoteStatus,
        confirmed_at: confirmedAt,
        register_session_id: input.registerSessionId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    if (itemLines.length > 0) {
      await trx
        .insertInto('order_items')
        .values(
          itemLines.map((line) => ({
            order_id: orderRow.id,
            product_id: line.product.id,
            product_code_snapshot: line.product.code,
            product_name_snapshot: line.product.name,
            unit_price_snapshot: line.product.price,
            quantity: line.quantity,
            subtotal: line.subtotal.toFixed(2),
            excluded_complements: line.excludedComplements,
          })),
        )
        .execute();
    }

    if (promotionLines.length > 0) {
      await trx
        .insertInto('order_promotions')
        .values(
          promotionLines.map((line) => ({
            order_id: orderRow.id,
            promotion_id: line.promo.id,
            promotion_name_snapshot: line.promo.name,
            promo_price_snapshot: line.promo.promo_price,
            combo_quantity: line.quantity,
            subtotal: line.subtotal.toFixed(2),
            components_snapshot: JSON.stringify(line.componentsSnapshot),
          })),
        )
        .execute();
    }

    const { items: insertedItems, promotions: insertedPromotions } = await loadOrderLines(
      trx,
      orderRow.id,
    );

    return toOrderResponse(orderRow, insertedItems, insertedPromotions);
  }

  /**
   * Ventana `late_review`: NO se llama a `createOrderInTransaction` — se
   * guarda el carrito crudo para revalidarlo por completo recién al aceptar
   * (`LateOrderRequestsService.accept`). Idempotencia propia por columna
   * única (mismo patrón que `delivery_quote_requests`), no la tabla
   * genérica `idempotency_keys`.
   */
  private async createLateOrderRequest(
    dto: CreateOrderDto,
    idempotencyKey: string,
    now: Date,
  ): Promise<LateOrderRequestAcceptedResponse> {
    const existing = await this.db
      .selectFrom('late_order_requests')
      .selectAll()
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (existing) return toLateOrderRequestAcceptedResponse(existing);

    const items = dto.items;
    const promotions = dto.promotions ?? [];
    if (items.length + promotions.length < 1) {
      throw new ValidationError('El carrito está vacío.');
    }

    const productIds = items.map((i) => i.productId);
    const promotionIds = promotions.map((p) => p.promotionId);

    const products =
      productIds.length > 0
        ? await this.db.selectFrom('products').selectAll().where('id', 'in', productIds).execute()
        : [];
    const productById = new Map(products.map((p) => [p.id, p]));

    const promotionRows =
      promotionIds.length > 0
        ? await this.db
            .selectFrom('promotions')
            .selectAll()
            .where('id', 'in', promotionIds)
            .execute()
        : [];
    const promotionById = new Map(promotionRows.map((p) => [p.id, p]));

    // Subtotal informativo (best-effort, con precios de HOY): la validación
    // autoritativa completa se repite entera al aceptar, vía
    // createOrderInTransaction. Un producto/promo que ya no exista no revienta
    // la solicitud — solo no suma al subtotal mostrado; se rechazará como
    // 'order_unavailable' recién al intentar aceptar.
    let subtotal = 0;
    for (const item of items) {
      const product = productById.get(item.productId);
      if (product) subtotal += Number(product.price) * item.quantity;
    }
    for (const p of promotions) {
      const promo = promotionById.get(p.promotionId);
      if (promo) subtotal += Number(promo.promo_price) * p.quantity;
    }
    if (subtotal <= 0) {
      throw new ValidationError('El total del pedido debe ser positivo.');
    }

    const expiresAt = lateRequestExpiryFor(now);

    const inserted = await this.db
      .insertInto('late_order_requests')
      .values({
        customer_id: dto.customerId ?? null,
        customer_name: dto.customerName.trim(),
        channel: dto.channel,
        delivery_type: dto.deliveryType,
        payment_method: dto.paymentMethod,
        notes: dto.notes?.trim() || null,
        items_json: JSON.stringify(items),
        promotions_json: JSON.stringify(promotions),
        subtotal_amount: subtotal.toFixed(2),
        idempotency_key: idempotencyKey,
        expires_at: expiresAt,
      })
      .onConflict((oc) => oc.column('idempotency_key').doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted) {
      try {
        await this.notifications.notifyNow({
          channel: 'telegram',
          kind: 'late_request_alert',
          targetRef: inserted.id,
          payload: {
            chatRef: 'staff-group',
            text: `Solicitud fuera de horario ${inserted.request_number} — ${inserted.customer_name}, total ${inserted.subtotal_amount}.`,
            buttons: [
              { label: 'Aceptar', action: `late-order-requests/${inserted.id}/accept` },
              { label: 'Rechazar', action: `late-order-requests/${inserted.id}/reject` },
            ],
          },
        });
      } catch (error) {
        this.logger.warn(
          `No se pudo avisar al mostrador sobre ${inserted.id}: ${(error as Error).message}`,
        );
      }
      return toLateOrderRequestAcceptedResponse(inserted);
    }

    const winner = await this.db
      .selectFrom('late_order_requests')
      .selectAll()
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirstOrThrow();
    return toLateOrderRequestAcceptedResponse(winner);
  }

  async requestLocation(orderId: string): Promise<void> {
    const order = await this.db
      .selectFrom('orders')
      .select(['id', 'delivery_type', 'customer_id'])
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order) throw new NotFoundDomainError('order', orderId);
    if (order.delivery_type !== 'delivery') {
      throw new ValidationError('El pedido no es de delivery.');
    }
    if (!order.customer_id) {
      throw new ValidationError('El pedido no tiene un cliente al cual pedirle ubicación.');
    }

    await this.notifications.notifyNow({
      channel: 'whatsapp',
      kind: 'location_request',
      targetRef: order.id,
      payload: { customerId: order.customer_id, reason: 'delivery_location' },
    });
  }

  /** Dispara la cotización de delivery atada al pedido (ver DeliveryService.quoteForOrder). */
  async attachLocation(
    orderId: string,
    location: { latitude: number; longitude: number },
  ): Promise<OrderResponse> {
    const order = await this.db
      .selectFrom('orders')
      .select(['id', 'delivery_type'])
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order) throw new NotFoundDomainError('order', orderId);
    if (order.delivery_type !== 'delivery') {
      throw new ValidationError('El pedido no es de delivery.');
    }

    await this.db
      .updateTable('orders')
      .set({
        delivery_latitude: location.latitude,
        delivery_longitude: location.longitude,
        updated_at: new Date(),
      })
      .where('id', '=', orderId)
      .execute();

    await this.deliveryService.quoteForOrder(orderId);
    return this.findById(orderId);
  }

  async addKitchenNote(orderId: string, note: string): Promise<OrderResponse> {
    const order = await this.db
      .selectFrom('orders')
      .select(['id', 'notes'])
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order) throw new NotFoundDomainError('order', orderId);

    const trimmed = note.trim();
    if (!trimmed) throw new ValidationError('La nota no puede estar vacía.');

    const combined = order.notes ? `${order.notes}\n${trimmed}` : trimmed;
    if (combined.length > 500) {
      throw new ValidationError('Las notas admiten como máximo 500 caracteres en total.');
    }

    const updated = await this.db
      .updateTable('orders')
      .set({ notes: combined, updated_at: new Date() })
      .where('id', '=', orderId)
      .returningAll()
      .executeTakeFirstOrThrow();

    const { items, promotions } = await loadOrderLines(this.db, orderId);
    return toOrderResponse(updated, items, promotions);
  }

  async switchToPickup(orderId: string): Promise<OrderResponse> {
    return this.db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', orderId)
        .forUpdate()
        .executeTakeFirst();
      if (!order) throw new NotFoundDomainError('order', orderId);
      if (order.delivery_type !== 'delivery') {
        throw new ValidationError(`El pedido ya es ${order.delivery_type}, no es un delivery.`);
      }
      if (order.delivery_quote_status === 'quoted') {
        throw new DomainException(
          'delivery_already_quoted',
          HttpStatus.CONFLICT,
          'No se puede cambiar a pickup: el delivery ya fue cotizado y confirmado.',
        );
      }

      const totalAmount = Number(order.subtotal_amount);
      const updated = await trx
        .updateTable('orders')
        .set({
          delivery_type: 'pickup',
          delivery_pricing: null,
          delivery_quote_status: null,
          delivery_distance_meters: null,
          delivery_latitude: null,
          delivery_longitude: null,
          delivery_base_amount: '0',
          delivery_surcharge_amount: '0',
          total_amount: totalAmount.toFixed(2),
          status: 'confirmed',
          confirmed_at: order.confirmed_at ?? new Date(),
          updated_at: new Date(),
        })
        .where('id', '=', orderId)
        .returningAll()
        .executeTakeFirstOrThrow();

      const { items, promotions } = await loadOrderLines(trx, orderId);
      return toOrderResponse(updated, items, promotions);
    });
  }

  /**
   * CAS sobre cash_confirmed_at (invariante 5): el efecto (avisar grupo de
   * delivery, luego al cliente) solo se dispara si ESTA llamada ganó el CAS.
   *
   * Vincula el pedido a la caja abierta en este momento (invariante de
   * caja: la plata se atribuye al turno en que entra de verdad) — salvo que
   * ya venga vinculado (pedido fuera de horario, se etiquetó al aceptarse).
   * Por eso deja de ser un UPDATE suelto y pasa a `SELECT ... FOR UPDATE` +
   * transacción, igual que `switchToPickup`.
   */
  /**
   * POST /orders/:id/split-payment — arma un pago dividido (efectivo + QR)
   * ANTES de confirmar ninguna de las dos patas. Los dos montos los declara
   * el cajero por separado y tienen que sumar EXACTO el total del pedido —
   * nunca se calcula un monto a partir del otro, para que un error de
   * tipeo salte acá y no como una diferencia de caja al cerrar la noche.
   * Solo mientras el pedido sigue `unpaid`: no se puede convertir a split
   * un pedido que ya tiene una pata cobrada por otro método.
   */
  async setSplitPayment(
    orderId: string,
    cashAmount: number,
    qrAmount: number,
  ): Promise<OrderResponse> {
    const order = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order) throw new NotFoundDomainError('order', orderId);
    if (order.payment_status !== 'unpaid') {
      throw new DomainException(
        'order_already_paid',
        HttpStatus.CONFLICT,
        'El pedido ya tiene un pago en curso o confirmado — no se puede dividir ahora.',
      );
    }
    const total = Number(order.total_amount);
    const sum = Math.round((cashAmount + qrAmount) * 100) / 100;
    if (sum !== Math.round(total * 100) / 100) {
      throw new ValidationError(
        `Efectivo (${cashAmount.toFixed(2)}) + QR (${qrAmount.toFixed(2)}) debe sumar exactamente el total del pedido (${total.toFixed(2)}).`,
      );
    }

    const updated = await this.db
      .updateTable('orders')
      .set({
        payment_method: 'split',
        split_cash_amount: cashAmount.toFixed(2),
        split_qr_amount: qrAmount.toFixed(2),
        split_cash_confirmed_at: null,
        updated_at: new Date(),
      })
      .where('id', '=', orderId)
      .returningAll()
      .executeTakeFirstOrThrow();

    const { items, promotions } = await loadOrderLines(this.db, updated.id);
    return toOrderResponse(updated, items, promotions);
  }

  /**
   * CAS sobre cash_confirmed_at (invariante 5): el efecto (avisar grupo de
   * delivery, luego al cliente) solo se dispara si ESTA llamada ganó el CAS.
   *
   * Vincula el pedido a la caja abierta en este momento (invariante de
   * caja: la plata se atribuye al turno en que entra de verdad) — salvo que
   * ya venga vinculado (pedido fuera de horario, se etiquetó al aceptarse).
   * Por eso deja de ser un UPDATE suelto y pasa a `SELECT ... FOR UPDATE` +
   * transacción, igual que `switchToPickup`.
   *
   * Con `payment_method='split'` confirma solo la PATA efectivo
   * (`split_cash_confirmed_at`, nunca `cash_confirmed_at` — son campos
   * distintos a propósito, para no confundir "cuánto de esto es 100%
   * efectivo" con "la pata efectivo de un split"). `payment_status` recién
   * pasa a `paid` cuando la pata QR también está `accepted` — si ya lo
   * estaba (llegó primero), acá se completa; si no, el pedido queda
   * `unpaid` hasta que `PaymentAttemptsService.decide()` la confirme.
   */
  async confirmCash(orderId: string): Promise<OrderResponse> {
    const result = await this.db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', orderId)
        .forUpdate()
        .executeTakeFirst();
      if (!order) throw new NotFoundDomainError('order', orderId);
      if (order.payment_method !== 'cash' && order.payment_method !== 'split') {
        throw new ValidationError('El pedido no es de pago en efectivo.');
      }
      const isSplit = order.payment_method === 'split';
      const alreadyConfirmed = isSplit
        ? order.split_cash_confirmed_at !== null
        : order.cash_confirmed_at !== null;
      if (alreadyConfirmed) return null; // ya confirmado, comportamiento idempotente de abajo

      const registerSessionId =
        order.register_session_id ?? (await this.cashRegister.assertOpenSessionId(trx));

      let qrLegAccepted = false;
      if (isSplit) {
        const acceptedQr = await trx
          .selectFrom('payment_attempts')
          .select('id')
          .where('order_id', '=', orderId)
          .where('review_status', '=', 'accepted')
          .executeTakeFirst();
        qrLegAccepted = acceptedQr !== undefined;
      }
      const fullyPaid = !isSplit || qrLegAccepted;

      const row = await trx
        .updateTable('orders')
        .set({
          ...(isSplit ? { split_cash_confirmed_at: new Date() } : { cash_confirmed_at: new Date() }),
          ...(fullyPaid ? { payment_status: 'paid' } : {}),
          register_session_id: registerSessionId,
          updated_at: new Date(),
        })
        .where('id', '=', orderId)
        .returningAll()
        .executeTakeFirstOrThrow();

      return { row, fullyPaid };
    });

    if (!result) {
      const existing = await this.findExistingCashOrder(orderId);
      const { items, promotions } = await loadOrderLines(this.db, existing.id);
      return toOrderResponse(existing, items, promotions);
    }
    const { row: updated, fullyPaid } = result;

    // En un split con la pata QR todavía pendiente, no hay nada "confirmado"
    // que avisarle a nadie todavía — recién cuando decide() complete la otra
    // pata se dispara el aviso de pago aceptado (payment-attempts.service.ts).
    if (fullyPaid) {
      try {
        if (updated.delivery_type === 'delivery') {
          await this.notifications.notifyNow({
            channel: 'telegram',
            kind: 'cash_confirmed_delivery_notice',
            targetRef: updated.id,
            payload: {
              chatRef: 'delivery-group',
              text: `Pedido ${updated.order_number} confirmado en efectivo.`,
            },
          });
        }
        if (updated.customer_id) {
          await this.notifications.notifyNow({
            channel: 'whatsapp',
            kind: 'cash_confirmed_customer_notice',
            targetRef: updated.id,
            payload: {
              customerId: updated.customer_id,
              text: `Tu pago en efectivo para el pedido ${updated.order_number} fue confirmado.`,
            },
          });
        }
      } catch (error) {
        this.logger.warn(
          `No se pudo notificar cash confirm para ${updated.id}: ${(error as Error).message}`,
        );
      }
    }

    const { items, promotions } = await loadOrderLines(this.db, updated.id);
    return toOrderResponse(updated, items, promotions);
  }

  /**
   * En un split solo revierte la pata efectivo (`split_cash_confirmed_at`)
   * — nunca toca `register_session_id`, porque la pata QR puede seguir
   * atada a esa sesión de verdad. `payment_status` vuelve a `unpaid`
   * siempre, esté o no la pata QR aceptada: sin las dos patas confirmadas
   * el pedido no está pagado, punto.
   */
  async cancelCash(orderId: string): Promise<OrderResponse> {
    const order = await this.db
      .selectFrom('orders')
      .select(['id', 'payment_method'])
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order) throw new NotFoundDomainError('order', orderId);
    const isSplit = order.payment_method === 'split';
    if (!isSplit && order.payment_method !== 'cash') {
      throw new ValidationError('El pedido no es de pago en efectivo.');
    }

    const updated = await this.db
      .updateTable('orders')
      .set(
        isSplit
          ? { split_cash_confirmed_at: null, payment_status: 'unpaid', updated_at: new Date() }
          : {
              cash_confirmed_at: null,
              payment_status: 'unpaid',
              register_session_id: null,
              updated_at: new Date(),
            },
      )
      .where('id', '=', orderId)
      .where(isSplit ? 'split_cash_confirmed_at' : 'cash_confirmed_at', 'is not', null)
      .returningAll()
      .executeTakeFirst();

    const result = updated ?? (await this.findExistingCashOrder(orderId));
    const { items, promotions } = await loadOrderLines(this.db, result.id);
    return toOrderResponse(result, items, promotions);
  }

  private async findExistingCashOrder(orderId: string) {
    const existing = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!existing) throw new NotFoundDomainError('order', orderId);
    if (existing.payment_method !== 'cash' && existing.payment_method !== 'split') {
      throw new ValidationError('El pedido no es de pago en efectivo.');
    }
    return existing;
  }

  /**
   * PATCH /orders/:id/status — transición legal + CAS optimista. `updatedBy`
   * es el username del staff autenticado (tablero de cocina, JWT) — queda
   * guardado en `status_updated_by` para saber quién movió el pedido.
   *
   * Pago contra entrega SOLO existe para delivery + cash (el repartidor
   * cobra en la puerta) — ahí `preparing` no exige `paid` todavía. Todo lo
   * demás (pickup/POS, y delivery con QR — un QR no se "entrega") sí exige
   * `payment_status: 'paid'` antes de `-> preparing`, porque en esos casos
   * el pago siempre se confirma ANTES de que cocina empiece.
   */
  async updateStatus(
    orderId: string,
    to: OrderStatus,
    updatedBy: string | null,
  ): Promise<OrderResponse> {
    const order = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order) throw new NotFoundDomainError('order', orderId);

    const allowed = ORDER_STATUS_TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(to)) {
      throw new InvalidStateTransitionError('order', order.status, to);
    }

    const isCashOnDelivery = order.delivery_type === 'delivery' && order.payment_method === 'cash';
    if (to === 'preparing' && !isCashOnDelivery && order.payment_status !== 'paid') {
      throw new DomainException(
        'payment_required',
        HttpStatus.CONFLICT,
        'El pedido debe estar pagado antes de empezar a prepararse.',
        { paymentStatus: order.payment_status },
      );
    }

    const updated = await this.db
      .updateTable('orders')
      .set({ status: to, status_updated_by: updatedBy, updated_at: new Date() })
      .where('id', '=', orderId)
      .where('status', '=', order.status)
      .returningAll()
      .executeTakeFirst();

    if (!updated) {
      throw new DomainException(
        'status_conflict',
        HttpStatus.CONFLICT,
        'El estado del pedido cambió antes de aplicar esta transición; reintenta.',
      );
    }

    if (to === 'cancelled' && order.payment_method === 'qr') {
      this.qrPayments
        .cancelForOrder(orderId)
        .catch((error: Error) =>
          this.logger.warn(`No se pudo cancelar el QR bancario de ${orderId}: ${error.message}`),
        );
    }

    const { items, promotions } = await loadOrderLines(this.db, orderId);
    return toOrderResponse(updated, items, promotions);
  }

  /**
   * Cancela los pedidos que siguen sin pagar pasado `ttlMinutes` (WhatsApp y
   * POS por igual): cocina no puede empezar un pedido impago, así que no tiene
   * sentido dejarlos vivos. Se salvan los que ya tienen algo cobrado (una pata
   * de split, un pago bancario detectado) y el contra entrega en efectivo, que
   * se cobra al llegar. Devuelve cuántos canceló.
   */
  async expireUnpaidOrders(ttlMinutes: number): Promise<number> {
    const cancellable: OrderStatus[] = ['draft', 'awaiting_location', 'confirmed'];
    const cutoff = new Date(Date.now() - ttlMinutes * 60_000);

    const candidates = await this.db
      .selectFrom('orders')
      .select(['id', 'order_number', 'customer_id', 'channel', 'payment_method'])
      .where('status', 'in', cancellable)
      .where('payment_status', '=', 'unpaid')
      .where('created_at', '<', cutoff)
      .where('cash_confirmed_at', 'is', null)
      .where('split_cash_confirmed_at', 'is', null)
      .where((eb) => eb.not(eb.and([eb('delivery_type', '=', 'delivery'), eb('payment_method', '=', 'cash')])))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('bank_qr_charges')
              .select('bank_qr_charges.id')
              .whereRef('bank_qr_charges.order_id', '=', 'orders.id')
              .where((cb) =>
                cb.or([
                  cb('bank_qr_charges.status', 'in', ['confirmed', 'paid_unapplied']),
                  cb('bank_qr_charges.paid_detected_at', 'is not', null),
                ]),
              ),
          ),
        ),
      )
      .orderBy('created_at')
      .limit(50)
      .execute();

    let expired = 0;
    for (const order of candidates) {
      try {
        // Última mirada al banco antes de cancelar: si el cliente pagó en el
        // último momento, el polling de 5s todavía podría no haberlo visto.
        if (order.payment_method === 'qr' || order.payment_method === 'split') {
          const pending = await this.db
            .selectFrom('bank_qr_charges')
            .select('qr_id')
            .where('order_id', '=', order.id)
            .where('status', '=', 'pending')
            .execute();
          for (const charge of pending) await this.qrPayments.resolveCharge(charge.qr_id);
        }

        // El WHERE repite las condiciones clave: si el pago entró mientras
        // tanto, no se cancela.
        const cancelled = await this.db
          .updateTable('orders')
          .set({ status: 'cancelled', status_updated_by: 'system', updated_at: new Date() })
          .where('id', '=', order.id)
          .where('payment_status', '=', 'unpaid')
          .where('status', 'in', cancellable)
          .returning('id')
          .executeTakeFirst();
        if (!cancelled) continue;
        expired += 1;

        if (order.payment_method === 'qr' || order.payment_method === 'split') {
          await this.qrPayments.cancelForOrder(order.id);
        }
        if (order.channel === 'whatsapp' && order.customer_id) {
          await this.notifications.notifyNow({
            channel: 'whatsapp',
            kind: 'order_expired_unpaid',
            targetRef: order.id,
            payload: {
              customerId: order.customer_id,
              text: `Cancelamos tu pedido ${order.order_number} porque no recibimos el pago a tiempo. Si todavía lo querés, podés hacer un pedido nuevo.`,
            },
          });
        }
      } catch (error) {
        this.logger.warn(
          `No se pudo vencer el pedido ${order.order_number}: ${(error as Error).message}`,
        );
      }
    }
    return expired;
  }
}

function toLateOrderRequestAcceptedResponse(row: {
  id: string;
  request_number: string;
  subtotal_amount: string;
  expires_at: Date | string;
}): LateOrderRequestAcceptedResponse {
  return {
    requestId: row.id,
    requestNumber: row.request_number,
    status: 'pending',
    subtotalAmount: Number(row.subtotal_amount),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/** Clave normalizada (orden-insensible) para comparar la selección de complementos excluidos de dos líneas. */
function complementsKey(excluded: string[] | undefined): string {
  return JSON.stringify([...(excluded ?? [])].sort());
}

function groupByOrderId<T extends { order_id: string }>(rows: T[]): Map<string, T[]> {
  const byOrder = new Map<string, T[]>();
  for (const row of rows) {
    const list = byOrder.get(row.order_id) ?? [];
    list.push(row);
    byOrder.set(row.order_id, list);
  }
  return byOrder;
}

/** Transaction<Database> extiende Kysely<Database>, así que sirve dentro y fuera de una transacción. */
async function loadOrderLines(db: Kysely<Database>, orderId: string) {
  const items = await db
    .selectFrom('order_items')
    .selectAll()
    .where('order_id', '=', orderId)
    .execute();
  const promotions = await db
    .selectFrom('order_promotions')
    .selectAll()
    .where('order_id', '=', orderId)
    .execute();
  return { items, promotions };
}

function toOrderResponse(
  order: {
    id: string;
    order_number: string;
    customer_id: string | null;
    channel: string;
    customer_name: string;
    delivery_type: string;
    payment_method: string;
    payment_status: string;
    notes: string | null;
    status: string;
    subtotal_amount: string;
    delivery_base_amount: string;
    delivery_surcharge_amount: string;
    total_amount: string;
    delivery_quote_status: string | null;
    delivery_distance_meters: number | null;
    cash_confirmed_at: Date | string | null;
    split_cash_amount: string | null;
    split_qr_amount: string | null;
    split_cash_confirmed_at: Date | string | null;
    status_updated_by: string | null;
    created_at: Date | string;
  },
  items: {
    product_id: string;
    product_code_snapshot: string;
    product_name_snapshot: string;
    unit_price_snapshot: string;
    quantity: number;
    subtotal: string;
    excluded_complements: string[];
  }[],
  promotions: {
    promotion_id: string | null;
    promotion_name_snapshot: string;
    promo_price_snapshot: string;
    combo_quantity: number;
    subtotal: string;
    components_snapshot: OrderPromotionComponentSnapshot[];
  }[],
): OrderResponse {
  return {
    id: order.id,
    orderNumber: order.order_number,
    customerId: order.customer_id,
    channel: order.channel,
    customerName: order.customer_name,
    deliveryType: order.delivery_type,
    paymentMethod: order.payment_method,
    paymentStatus: order.payment_status,
    notes: order.notes,
    status: order.status,
    subtotalAmount: Number(order.subtotal_amount),
    deliveryBaseAmount: Number(order.delivery_base_amount),
    deliverySurchargeAmount: Number(order.delivery_surcharge_amount),
    totalAmount: Number(order.total_amount),
    deliveryQuoteStatus: order.delivery_quote_status,
    deliveryDistanceMeters: order.delivery_distance_meters,
    cashConfirmedAt: order.cash_confirmed_at
      ? new Date(order.cash_confirmed_at).toISOString()
      : null,
    splitCashAmount: order.split_cash_amount === null ? null : Number(order.split_cash_amount),
    splitQrAmount: order.split_qr_amount === null ? null : Number(order.split_qr_amount),
    splitCashConfirmedAt: order.split_cash_confirmed_at
      ? new Date(order.split_cash_confirmed_at).toISOString()
      : null,
    statusUpdatedBy: order.status_updated_by,
    createdAt: new Date(order.created_at).toISOString(),
    items: items.map((item) => ({
      productId: item.product_id,
      productCodeSnapshot: item.product_code_snapshot,
      productNameSnapshot: item.product_name_snapshot,
      unitPriceSnapshot: Number(item.unit_price_snapshot),
      quantity: item.quantity,
      subtotal: Number(item.subtotal),
      excludedComplements: item.excluded_complements,
    })),
    promotions: promotions.map((promotion) => ({
      promotionId: promotion.promotion_id,
      promotionNameSnapshot: promotion.promotion_name_snapshot,
      promoPriceSnapshot: Number(promotion.promo_price_snapshot),
      comboQuantity: promotion.combo_quantity,
      subtotal: Number(promotion.subtotal),
      componentsSnapshot: promotion.components_snapshot,
    })),
  };
}

import { Inject, Injectable, NotImplementedException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database, OrderStatus } from '../database/types';
import { NotFoundDomainError } from '../common/exceptions/domain-exception';
import { CreateOrderDto } from './dto/create-order.dto';

export interface OrderItemResponse {
  productId: string;
  productCodeSnapshot: string;
  productNameSnapshot: string;
  unitPriceSnapshot: number;
  quantity: number;
  subtotal: number;
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
  subtotalAmount: number;
  deliveryBaseAmount: number;
  deliverySurchargeAmount: number;
  totalAmount: number;
  createdAt: string;
  items: OrderItemResponse[];
}

/**
 * Corazón del sistema (fase 3 de la estrategia de migración del plan). Este
 * archivo es un ESQUELETO deliberado: trae las lecturas (bajo riesgo) ya
 * funcionando y deja las escrituras que mueven dinero como stubs con el
 * contrato exacto que describe el plan, para implementarlas y probarlas
 * exhaustivamente en su propia sesión — no se improvisan aquí.
 */
@Injectable()
export class OrdersService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async findById(id: string): Promise<OrderResponse> {
    const order = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!order) throw new NotFoundDomainError('order', id);

    const items = await this.db
      .selectFrom('order_items')
      .selectAll()
      .where('order_id', '=', id)
      .execute();

    return toOrderResponse(order, items);
  }

  async findMany(filter: { customerId?: string; status?: OrderStatus }): Promise<OrderResponse[]> {
    let query = this.db.selectFrom('orders').selectAll();
    if (filter.customerId) query = query.where('customer_id', '=', filter.customerId);
    if (filter.status) query = query.where('status', '=', filter.status);
    const orders = await query.orderBy('created_at', 'desc').execute();

    if (orders.length === 0) return [];
    const items = await this.db
      .selectFrom('order_items')
      .selectAll()
      .where(
        'order_id',
        'in',
        orders.map((o) => o.id),
      )
      .execute();

    const itemsByOrder = new Map<string, typeof items>();
    for (const item of items) {
      const list = itemsByOrder.get(item.order_id) ?? [];
      list.push(item);
      itemsByOrder.set(item.order_id, list);
    }
    return orders.map((order) => toOrderResponse(order, itemsByOrder.get(order.id) ?? []));
  }

  /**
   * POST /orders — TODO fase de implementación (portar create_order_web_v5):
   * 1. Gate de horario evaluado ANTES que nada, con reloj de servidor:
   *    cerrado -> 409 'closed'; ventana late_review (23:00-00:00) -> 202 +
   *    crear late_order_requests en vez de un pedido (a menos que
   *    dto.bypassHoursGate venga autorizado por rol de staff).
   * 2. Envolver TODO en IdempotencyService.run({ apiClient, endpoint:
   *    'POST /orders', idempotencyKey, requestBody: dto, execute: trx => ... }).
   * 3. Dentro de la transacción: recalcular precio y disponibilidad de cada
   *    item/promoción EN SERVIDOR (nunca aceptar precios del cliente) —
   *    product_unavailable (is_active=false) vs sold-out (is_available=false)
   *    son códigos de error distintos (invariante 4).
   * 4. Snapshot de nombre/precio por línea y de componentes de combo en
   *    order_promotions.components_snapshot — nunca se recalculan después
   *    (invariante 3).
   * 5. Insertar orders + order_items + order_promotions con los mismos
   *    candados/orden de operaciones que create_order_web_v5.
   * 6. Errores de negocio siempre como DomainException con código estable
   *    (product_unavailable, promotion_unavailable, validation_error) —
   *    nunca dejar pasar un error crudo de Postgres (invariante 8).
   */
  async create(
    _dto: CreateOrderDto,
    _idempotencyKey: string,
    _apiClient: string,
  ): Promise<OrderResponse> {
    throw new NotImplementedException(
      'POST /orders todavía no está implementado — ver TODO en OrdersService.create.',
    );
  }

  async requestLocation(_orderId: string): Promise<void> {
    throw new NotImplementedException('POST /orders/:id/location-request pendiente.');
  }

  async attachLocation(
    _orderId: string,
    _location: { latitude: number; longitude: number },
  ): Promise<OrderResponse> {
    throw new NotImplementedException(
      'POST /orders/:id/location pendiente — dispara la cotización de delivery atada a pedido (ver módulo `delivery`).',
    );
  }

  async addKitchenNote(_orderId: string, _note: string): Promise<OrderResponse> {
    throw new NotImplementedException('POST /orders/:id/kitchen-note pendiente.');
  }

  async switchToPickup(_orderId: string): Promise<OrderResponse> {
    throw new NotImplementedException('POST /orders/:id/switch-to-pickup pendiente.');
  }

  /**
   * TODO: CAS sobre cash_confirmed_at, orden fijo: confirmar -> avisar grupo
   * de delivery (NotificationsOutService) -> responder al cliente. El aviso
   * solo se dispara si ESTA llamada ganó el CAS (invariante 5).
   */
  async confirmCash(_orderId: string): Promise<OrderResponse> {
    throw new NotImplementedException('POST /orders/:id/cash/confirm pendiente.');
  }

  async cancelCash(_orderId: string): Promise<OrderResponse> {
    throw new NotImplementedException('POST /orders/:id/cash/cancel pendiente.');
  }

  /** TODO: validar transición legal de `status` + CAS optimista. */
  async updateStatus(_orderId: string, _to: OrderStatus): Promise<OrderResponse> {
    throw new NotImplementedException('PATCH /orders/:id/status pendiente.');
  }
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
    status: string;
    subtotal_amount: string;
    delivery_base_amount: string;
    delivery_surcharge_amount: string;
    total_amount: string;
    created_at: Date | string;
  },
  items: {
    product_id: string;
    product_code_snapshot: string;
    product_name_snapshot: string;
    unit_price_snapshot: string;
    quantity: number;
    subtotal: string;
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
    status: order.status,
    subtotalAmount: Number(order.subtotal_amount),
    deliveryBaseAmount: Number(order.delivery_base_amount),
    deliverySurchargeAmount: Number(order.delivery_surcharge_amount),
    totalAmount: Number(order.total_amount),
    createdAt: new Date(order.created_at).toISOString(),
    items: items.map((item) => ({
      productId: item.product_id,
      productCodeSnapshot: item.product_code_snapshot,
      productNameSnapshot: item.product_name_snapshot,
      unitPriceSnapshot: Number(item.unit_price_snapshot),
      quantity: item.quantity,
      subtotal: Number(item.subtotal),
    })),
  };
}

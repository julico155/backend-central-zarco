import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database, OrderDeliveryType, OrderPaymentMethod } from '../database/types';
import { DomainException } from '../common/exceptions/domain-exception';
import {
  assertPaymentMethodAllowed,
  resolveOrderChannel,
  WHATSAPP_API_CLIENT,
} from '../orders/order-channel';
import { CreateOrderDto } from '../orders/dto/create-order.dto';
import { OrderItemInputDto } from '../orders/dto/order-item-input.dto';
import { OrderPromotionInputDto } from '../orders/dto/order-promotion-input.dto';
import { OrdersService } from '../orders/orders.service';
import { CustomersService } from '../customers/customers.service';
import { MenuSessionRepository } from './menu-session.repository';
import { hashMenuSessionToken } from './menu-session-token';
import { SubmitMenuOrderDto } from './dto/submit-menu-order.dto';

/**
 * Traduce el carrito del menú web al `CreateOrderDto` que YA usa
 * `OrdersService`, y llama al servicio DIRECTO (nunca al controller HTTP,
 * nunca `create_order_web_v4`, nunca Supabase de sarcoRestaurant). Todas las
 * reglas de negocio (precios, disponibilidad, promociones con `revision`,
 * estado del pedido según `deliveryType`, numeración, QR automático) siguen
 * viviendo SOLO en `OrdersService` — ver su reporte de auditoría, Fase 2C.
 *
 * ── Identidad ─────────────────────────────────────────────────────────────
 * El teléfono NUNCA sale del body del cliente: sale de `menu_sessions`,
 * igual que en la RPC `create_order_web_v4` de sarcoRestaurant (`p_menu_session_id`
 * ⇒ `select customer_phone from menu_sessions`). El cliente solo manda el
 * `session_token`.
 *
 * ── Idempotencia (retry no duplica pedido) ───────────────────────────────
 * Se reutiliza el `Idempotency-Key` genérico de `OrdersService.create`
 * (`IdempotencyService`, ver su reporte): la clave es el `id` de la sesión.
 * Mismo carrito reenviado con la misma sesión ⇒ mismo hash de contenido ⇒
 * responde el pedido YA creado. Un carrito DISTINTO para la MISMA sesión
 * produce un hash distinto con la MISMA clave ⇒ `IdempotencyKeyReusedError`
 * (409) — el equivalente exacto del `P1003` (sesión reutilizada con otro
 * carrito) de la RPC vieja, sin duplicar ninguna lógica nueva.
 */
@Injectable()
export class MenuOrderService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly sessions: MenuSessionRepository,
    private readonly customers: CustomersService,
    private readonly orders: OrdersService,
  ) {}

  async submit(dto: SubmitMenuOrderDto) {
    const tokenHash = hashMenuSessionToken(dto.session_token);
    const session = await this.sessions.findByHash(tokenHash);
    if (session === null) {
      throw new DomainException(
        'invalid_session',
        HttpStatus.UNAUTHORIZED,
        'El enlace del menú venció o no es válido. Pedí uno nuevo por WhatsApp.',
      );
    }

    const channel = resolveOrderChannel(WHATSAPP_API_CLIENT);
    const paymentMethod = dto.payment_method as OrderPaymentMethod;
    // Nunca reescribe silenciosamente cash -> qr: si la UI todavía ofrece
    // efectivo, el cliente tiene que enterarse de que no se puede, no que
    // Central le cambió el método sin decirle.
    assertPaymentMethodAllowed(channel, paymentMethod);

    const customer = await this.customers.findOrCreate({ phone: session.customerPhone });
    const items = await this.resolveItems(dto.items);

    const createDto = new CreateOrderDto();
    createDto.customerId = customer.id;
    createDto.channel = channel;
    createDto.customerName = dto.customer_name;
    createDto.deliveryType = dto.delivery_type as OrderDeliveryType;
    createDto.paymentMethod = paymentMethod;
    createDto.notes = dto.notes;
    createDto.items = items;
    createDto.promotions = dto.promotions?.map(toOrderPromotionInput);

    // Una idempotency key por SESIÓN, no por intento: ver cabecera del
    // módulo. Reutiliza el mecanismo genérico de OrdersService.create tal
    // cual, sin ninguna capa propia.
    return this.orders.create(createDto, session.id, WHATSAPP_API_CLIENT);
  }

  /** `code` (lo que manda la UI) -> `productId` (lo que exige `CreateOrderDto`). */
  private async resolveItems(
    items: readonly { code: string; quantity: number; excluded_complements?: string[] }[],
  ): Promise<OrderItemInputDto[]> {
    if (items.length === 0) {
      throw new DomainException(
        'empty_cart',
        HttpStatus.BAD_REQUEST,
        'El pedido no tiene productos.',
      );
    }

    const codes = [...new Set(items.map((item) => item.code))];
    const rows = await this.db
      .selectFrom('products')
      .select(['id', 'code'])
      .where('code', 'in', codes)
      .execute();
    const idByCode = new Map(rows.map((row) => [row.code, row.id]));

    const missing = codes.filter((code) => !idByCode.has(code));
    if (missing.length > 0) {
      throw new DomainException(
        'product_not_found',
        HttpStatus.BAD_REQUEST,
        `Estos productos ya no están disponibles: ${missing.join(', ')}.`,
        { codes: missing },
      );
    }

    return items.map((item) => {
      const input = new OrderItemInputDto();
      input.productId = idByCode.get(item.code)!;
      input.quantity = item.quantity;
      input.excludedComplements = item.excluded_complements;
      return input;
    });
  }
}

function toOrderPromotionInput(promotion: {
  promotion_id: string;
  quantity: number;
  revision: number;
}): OrderPromotionInputDto {
  const input = new OrderPromotionInputDto();
  input.promotionId = promotion.promotion_id;
  input.quantity = promotion.quantity;
  input.revision = promotion.revision;
  return input;
}

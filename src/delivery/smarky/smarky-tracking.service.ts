import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../../database/database.module';
import { Database } from '../../database/types';
import { normalizePhone } from '../../customers/normalize-phone';
import { shortOrderNumber } from '../../delivery-notices/delivery-notice';
import { isTerminalDeliveryStatus } from './smarky-status';

export type SmarkyTrackingResult =
  | { result: 'no_tracking' }
  | { result: 'tracking'; orderNumber: string; trackingUrl: string; deliveryStatus: string };

/**
 * Link de seguimiento del pedido en curso de un cliente, para que el agente conteste
 * "¿dónde está mi pedido?". Solo lee lo que ya se guardó: id de pedido, link y estado.
 * NUNCA devuelve el código de entrega (no se persiste en ningún lado).
 */
@Injectable()
export class SmarkyTrackingService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async findForPhone(customerPhoneRaw: string): Promise<SmarkyTrackingResult> {
    const phone = normalizePhone(customerPhoneRaw, { assumeInternational: true });
    const customer = await this.db.selectFrom('customers').select('id').where('phone', '=', phone).executeTakeFirst();
    if (!customer) return { result: 'no_tracking' };

    const order = await this.db
      .selectFrom('orders')
      .select(['order_number', 'smarky_tracking_url', 'smarky_delivery_status'])
      .where('customer_id', '=', customer.id)
      .where('delivery_type', '=', 'delivery')
      .where('smarky_tracking_url', 'is not', null)
      .where('status', 'not in', ['delivered', 'cancelled'])
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!order || !order.smarky_tracking_url) return { result: 'no_tracking' };
    // `cancelled` / `failed`: la plataforma soltó la entrega y el link ya no sirve para seguir nada.
    if (isTerminalDeliveryStatus(order.smarky_delivery_status)) return { result: 'no_tracking' };

    return {
      result: 'tracking',
      orderNumber: shortOrderNumber(order.order_number),
      trackingUrl: order.smarky_tracking_url,
      deliveryStatus: order.smarky_delivery_status ?? 'searching',
    };
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely } from 'kysely';
import { AppConfig } from '../config/configuration';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { NotificationsOutService } from '../notifications-out/notifications-out.service';
import {
  buildDeliveryNotice,
  deliveryCollectOf,
  mergeNoticeItems,
  promotionsToNoticeItems,
  toNoticeCollect,
} from './delivery-notice';

export type DeliveryNoticeOutcome =
  'enqueued' | 'not_configured' | 'not_applicable' | 'order_not_found' | 'error';

/**
 * Emite el aviso de delivery al grupo de motos (kind `delivery_notice`,
 * targetRef = id del pedido) cuando el pedido queda LISTO PARA REPARTIR:
 * delivery + pagado + cotizado + con ubicación. Se llama desde cada punto en
 * que una de esas condiciones puede completarse (pago QR aceptado, efectivo
 * confirmado, split completo, cotización aplicada con el pago ya listo).
 *
 * Idempotente: el UNIQUE (kind, target_ref) de `notification_jobs` hace que
 * llamarlo N veces mande UN solo aviso. Nunca lanza: el pago o la cotización
 * ya se resolvieron y un Telegram caído no puede deshacerlos (el reintento lo
 * hace el cron de recuperación).
 */
@Injectable()
export class DeliveryNoticeService {
  private readonly logger = new Logger(DeliveryNoticeService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly notifications: NotificationsOutService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async tryNotify(orderId: string): Promise<DeliveryNoticeOutcome> {
    try {
      const telegram = this.config.get('telegram', { infer: true });
      if (!telegram.botToken || !telegram.chatId) return 'not_configured';

      const order = await this.db
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', orderId)
        .executeTakeFirst();
      if (!order) return 'order_not_found';

      if (
        order.delivery_type !== 'delivery' ||
        order.payment_status !== 'paid' ||
        order.delivery_quote_status !== 'quoted' ||
        order.delivery_latitude === null ||
        order.delivery_longitude === null
      ) {
        return 'not_applicable';
      }

      const [items, promotions, customer, proof] = await Promise.all([
        this.db
          .selectFrom('order_items')
          .select(['product_name_snapshot', 'quantity'])
          .where('order_id', '=', orderId)
          .orderBy('created_at', 'asc')
          .execute(),
        this.db
          .selectFrom('order_promotions')
          .select(['combo_quantity', 'components_snapshot'])
          .where('order_id', '=', orderId)
          .execute(),
        order.customer_id
          ? this.db
              .selectFrom('customers')
              .select('phone')
              .where('id', '=', order.customer_id)
              .executeTakeFirst()
          : Promise.resolve(undefined),
        this.db
          .selectFrom('payment_proofs')
          .select('analysis_amount_label')
          .where('order_id', '=', orderId)
          .where('analysis_status', '=', 'ok')
          .where('analysis_amount_label', 'is not', null)
          .orderBy('created_at', 'desc')
          .executeTakeFirst(),
      ]);

      const subtotal = Number(order.subtotal_amount);
      const total = Number(order.total_amount);
      const collect = deliveryCollectOf({
        deliveryType: order.delivery_type,
        paymentMethod: order.payment_method,
        totalAmount: total,
        subtotalAmount: subtotal,
        deliveryFeePaid: order.delivery_fee_paid,
        amountLabel: proof?.analysis_amount_label ?? null,
      });

      const text = buildDeliveryNotice({
        orderNumber: order.order_number,
        customerName: order.customer_name,
        customerPhone: customer?.phone?.trim() || 'sin teléfono',
        items: mergeNoticeItems([
          ...items.map((i) => ({ name: i.product_name_snapshot, quantity: i.quantity })),
          ...promotionsToNoticeItems(
            promotions.map((p) => ({
              comboQuantity: p.combo_quantity,
              components: p.components_snapshot,
            })),
          ),
        ]),
        deliveryAmount:
          Number(order.delivery_base_amount) + Number(order.delivery_surcharge_amount),
        subtotalAmount: subtotal,
        isCash: order.payment_method === 'cash',
        collect: toNoticeCollect(collect),
        customerNote: order.notes,
        latitude: order.delivery_latitude,
        longitude: order.delivery_longitude,
        distanceMeters: order.delivery_distance_meters,
      });

      await this.notifications.notifyNow({
        channel: 'telegram',
        kind: 'delivery_notice',
        targetRef: order.id,
        payload: { chatRef: 'delivery-group', text, parseMode: 'HTML' },
      });
      return 'enqueued';
    } catch (error) {
      this.logger.warn(
        `No se pudo emitir delivery_notice de ${orderId}: ${(error as Error).message}`,
      );
      return 'error';
    }
  }
}

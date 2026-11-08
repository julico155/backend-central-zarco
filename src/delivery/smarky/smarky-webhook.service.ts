import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely } from 'kysely';
import { AppConfig } from '../../config/configuration';
import { KYSELY } from '../../database/database.module';
import { Database } from '../../database/types';
import { DomainException, ValidationError } from '../../common/exceptions/domain-exception';
import { shortOrderNumber } from '../../delivery-notices/delivery-notice';
import { NotificationsOutService } from '../../notifications-out/notifications-out.service';
import { verifySmarkySignature } from './smarky-signature';
import { isAbandonedDeliveryStatus, isTerminalDeliveryStatus, orderStatusForDelivery } from './smarky-status';
import { SMARKY_DELIVERY_STATUSES, SmarkyDeliveryStatus, SmarkyWebhookEvent } from './smarky.types';

export type SmarkyWebhookResult = 'processed' | 'duplicate' | 'unknown_order';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Recibe los webhooks firmados de la plataforma y actualiza el estado del pedido.
 * No manda WhatsApp al cliente: sigue su pedido en la página de seguimiento. Solo
 * si la plataforma abandona la entrega (cancelled / failed) avisa al grupo de reparto
 * propio, para que el pedido ya pagado no se pierda.
 */
@Injectable()
export class SmarkyWebhookService {
  private readonly logger = new Logger(SmarkyWebhookService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly notifications: NotificationsOutService,
  ) {}

  get enabled(): boolean {
    const { provider, smarky } = this.config.get('delivery', { infer: true });
    return provider === 'smarky' && smarky.webhookSecret !== '';
  }

  async handle(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    nowMs: number = Date.now(),
  ): Promise<SmarkyWebhookResult> {
    const { smarky } = this.config.get('delivery', { infer: true });
    const check = verifySmarkySignature(smarky.webhookSecret, signature, rawBody, nowMs);
    if (!check.valid) {
      this.logger.warn(`Webhook de reparto rechazado (${check.reason}).`);
      throw new DomainException('invalid_signature', HttpStatus.UNAUTHORIZED, 'Firma inválida.');
    }

    const event = parseEvent(rawBody as Buffer);
    return this.apply(event);
  }

  private async apply(event: SmarkyWebhookEvent): Promise<SmarkyWebhookResult> {
    const { delivery } = event;

    // `externalOrderId` es el id del pedido: sirve aunque el evento llegue antes de que
    // se guardara `smarky_delivery_id` (la respuesta de POST /v1/entregas puede ir lenta).
    const order = await this.db
      .selectFrom('orders')
      .select(['id', 'order_number', 'customer_name'])
      .where((eb) =>
        eb.or([
          eb('smarky_delivery_id', '=', delivery.deliveryId),
          ...(UUID.test(delivery.externalOrderId) ? [eb('id', '=', delivery.externalOrderId)] : []),
        ]),
      )
      .executeTakeFirst();
    if (!order) {
      // Se responde 2xx igual: reintentar no lo va a hacer aparecer.
      this.logger.warn(`Webhook de reparto ${event.eventId}: no hay pedido para la entrega ${delivery.deliveryId}.`);
      return 'unknown_order';
    }

    const outcome = await this.db.transaction().execute(async (trx) => {
      const recorded = await trx
        .insertInto('smarky_webhook_events')
        .values({ event_id: event.eventId, delivery_id: delivery.deliveryId, event_type: event.type })
        .onConflict((oc) => oc.column('event_id').doNothing())
        .returning('event_id')
        .executeTakeFirst();
      if (!recorded) return { result: 'duplicate' as const, abandoned: false };

      const locked = await trx
        .selectFrom('orders')
        .select(['status', 'smarky_delivery_status'])
        .where('id', '=', order.id)
        .forUpdate()
        .executeTakeFirstOrThrow();

      // Un estado final no se pisa con uno posterior fuera de orden (p. ej. un `searching` rezagado).
      const keepDeliveryStatus =
        isTerminalDeliveryStatus(locked.smarky_delivery_status) && !isTerminalDeliveryStatus(delivery.status);
      const nextOrderStatus = keepDeliveryStatus ? null : orderStatusForDelivery(delivery.status, locked.status);
      const now = new Date();

      await trx
        .updateTable('orders')
        .set({
          smarky_delivery_id: delivery.deliveryId,
          smarky_tracking_url: delivery.trackingUrl,
          ...(keepDeliveryStatus ? {} : { smarky_delivery_status: delivery.status }),
          ...(nextOrderStatus ? { status: nextOrderStatus, status_updated_by: 'smarky' } : {}),
          ...(nextOrderStatus === 'delivered' ? { delivered_at: now } : {}),
          updated_at: now,
        })
        .where('id', '=', order.id)
        .execute();

      return {
        result: 'processed' as const,
        // Solo la primera vez que la entrega pasa a abandonada, para no avisar dos veces.
        abandoned:
          !keepDeliveryStatus &&
          isAbandonedDeliveryStatus(delivery.status) &&
          !isAbandonedDeliveryStatus(locked.smarky_delivery_status) &&
          locked.status !== 'cancelled' &&
          locked.status !== 'delivered',
      };
    });

    if (outcome.abandoned) await this.alertAbandoned(order, delivery.status);
    return outcome.result;
  }

  /** La plataforma soltó el pedido: vuelve al flujo propio (repartidores de Zarco) y se avisa al grupo. */
  private async alertAbandoned(
    order: { id: string; order_number: string; customer_name: string },
    status: SmarkyDeliveryStatus,
  ): Promise<void> {
    try {
      await this.notifications.notifyNow({
        channel: 'telegram',
        kind: 'smarky_delivery_abandoned',
        targetRef: order.id,
        payload: {
          chatRef: 'delivery-group',
          text: `La plataforma de reparto no pudo entregar el pedido ${shortOrderNumber(order.order_number)} (${order.customer_name}) — estado: ${status}. Atenderlo con un repartidor propio.`,
        },
      });
    } catch {
      this.logger.error(`Pedido ${order.id}: la plataforma abandonó la entrega y tampoco se pudo avisar al grupo.`);
    }
  }
}

function parseEvent(rawBody: Buffer): SmarkyWebhookEvent {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new ValidationError('El cuerpo del webhook no es JSON.');
  }
  const event = body as Partial<SmarkyWebhookEvent> | null;
  const delivery = event?.delivery;
  if (
    !event ||
    typeof event.eventId !== 'string' ||
    !UUID.test(event.eventId) ||
    typeof event.type !== 'string' ||
    !delivery ||
    typeof delivery.deliveryId !== 'string' ||
    !UUID.test(delivery.deliveryId) ||
    typeof delivery.externalOrderId !== 'string' ||
    typeof delivery.trackingUrl !== 'string' ||
    !SMARKY_DELIVERY_STATUSES.includes(delivery.status as SmarkyDeliveryStatus)
  ) {
    throw new ValidationError('El evento del webhook no tiene el formato esperado.');
  }
  return event as SmarkyWebhookEvent;
}

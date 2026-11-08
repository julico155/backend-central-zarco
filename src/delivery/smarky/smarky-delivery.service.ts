import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely } from 'kysely';
import { AppConfig } from '../../config/configuration';
import { KYSELY } from '../../database/database.module';
import { Database } from '../../database/types';
import { shortOrderNumber } from '../../delivery-notices/delivery-notice';
import { GatewayClientService } from '../../gateway-client/gateway-client.service';
import { NotificationsOutService } from '../../notifications-out/notifications-out.service';
import { SmarkyApiError, SmarkyClient } from './smarky-client';
import { buildTrackingMessage, toE164 } from './smarky-messages';
import { isAbandonedDeliveryStatus } from './smarky-status';
import { SmarkyDeliveryCreated } from './smarky.types';

export const SMARKY_CLIENT = Symbol('SMARKY_CLIENT');

/** Minutos hasta que la comida esté lista, para el repartidor. */
const PREP_ETA_MINUTES = 20;
/** Un reclamo `requesting` más viejo que esto se considera huérfano (el proceso murió a mitad). */
const STALE_CLAIM_MS = 2 * 60_000;

/**
 * - `dispatched`: la plataforma tiene la entrega; el aviso al grupo propio NO debe salir.
 * - `in_progress`: otro proceso ya pidió (o está pidiendo) la entrega; tampoco se avisa dos veces.
 * - `skipped`: no aplica (proveedor interno, pedido no elegible): sigue el flujo de siempre.
 * - `failed`: la plataforma no pudo; el llamador cae al aviso al grupo propio para no perder el pedido.
 */
export type SmarkyDispatchResult = 'dispatched' | 'in_progress' | 'skipped' | 'failed';

/**
 * Pide repartidor a la plataforma central cuando el pedido de delivery está listo
 * (pago confirmado, o efectivo ya cotizado). El seguimiento vive en la plataforma:
 * aquí solo se guarda el id/estado de la entrega y se manda al cliente el link
 * (con el código de entrega) por WhatsApp.
 */
@Injectable()
export class SmarkyDeliveryService implements OnModuleInit {
  private readonly logger = new Logger(SmarkyDeliveryService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly gateway: GatewayClientService,
    private readonly notifications: NotificationsOutService,
    @Inject(SMARKY_CLIENT) private readonly client: SmarkyClient | null,
  ) {}

  onModuleInit(): void {
    const { provider } = this.config.get('delivery', { infer: true });
    if (provider === 'smarky' && !this.client) {
      this.logger.error(
        'DELIVERY_PROVIDER=smarky pero faltan SMARKY_BASE_URL / SMARKY_API_KEY: se usa el reparto interno.',
      );
    }
  }

  get enabled(): boolean {
    return this.config.get('delivery', { infer: true }).provider === 'smarky' && this.client !== null;
  }

  /** Nunca lanza: cualquier fallo inesperado es `failed` y el pedido sigue por el flujo propio. */
  async dispatchForOrder(orderId: string): Promise<SmarkyDispatchResult> {
    try {
      return await this.tryDispatch(orderId);
    } catch (error) {
      this.logger.warn(`Pedido ${orderId}: error inesperado al pedir repartidor (${(error as Error).name}).`);
      await this.releaseClaim(orderId).catch(() => undefined);
      return 'failed';
    }
  }

  private async tryDispatch(orderId: string): Promise<SmarkyDispatchResult> {
    const client = this.client;
    if (!this.enabled || !client) return 'skipped';

    const order = await this.db.selectFrom('orders').selectAll().where('id', '=', orderId).executeTakeFirst();
    if (!order) return 'skipped';
    if (order.delivery_type !== 'delivery' || order.delivery_quote_status !== 'quoted') return 'skipped';
    if (order.status === 'cancelled' || order.status === 'delivered') return 'skipped';
    if (order.delivery_latitude === null || order.delivery_longitude === null) return 'skipped';
    if (order.payment_method !== 'cash' && order.payment_status !== 'paid') return 'skipped';
    if (order.smarky_delivery_id) {
      // Una entrega que la plataforma abandonó vuelve al flujo propio; cualquier otra ya está atendida.
      return isAbandonedDeliveryStatus(order.smarky_delivery_status) ? 'skipped' : 'in_progress';
    }

    // Un solo proceso pide la entrega: si dos eventos (cotización + pago) coinciden, el segundo
    // recibiría la entrega sin código y tendría que reemitirlo, invalidando el que ya salió.
    const claimed = await this.db
      .updateTable('orders')
      .set({ smarky_delivery_status: 'requesting', updated_at: new Date() })
      .where('id', '=', orderId)
      .where('smarky_delivery_id', 'is', null)
      .where((eb) =>
        eb.or([
          eb('smarky_delivery_status', 'is', null),
          eb.and([
            eb('smarky_delivery_status', '=', 'requesting'),
            eb('updated_at', '<', new Date(Date.now() - STALE_CLAIM_MS)),
          ]),
        ]),
      )
      .returning('id')
      .executeTakeFirst();
    if (!claimed) return 'in_progress';

    const customer = order.customer_id
      ? await this.db.selectFrom('customers').select('phone').where('id', '=', order.customer_id).executeTakeFirst()
      : undefined;
    const phone = toE164(customer?.phone);
    if (!phone) {
      this.logger.warn(`Pedido ${orderId}: el cliente no tiene un teléfono válido para la plataforma de reparto.`);
      await this.releaseClaim(orderId);
      return 'failed';
    }

    let created: SmarkyDeliveryCreated;
    try {
      const destination = { latitude: order.delivery_latitude, longitude: order.delivery_longitude };
      const request = (quoteId: string) => ({
        externalOrderId: order.id,
        quoteId,
        customer: { name: order.customer_name, phone },
        prepEtaMinutes: PREP_ETA_MINUTES,
        orderLabel: shortOrderNumber(order.order_number).slice(0, 32),
      });
      const quote = await client.createQuote(destination);
      try {
        created = await client.createDelivery(request(quote.quoteId));
      } catch (error) {
        if (!(error instanceof SmarkyApiError) || error.code !== 'quote_expired') throw error;
        created = await client.createDelivery(request((await client.createQuote(destination)).quoteId));
      }
    } catch (error) {
      // out_of_coverage, routing_unavailable agotado, etc.: nunca se inventa un precio ni se pierde el pedido.
      const code = error instanceof SmarkyApiError ? error.code : 'unexpected_error';
      this.logger.warn(`Pedido ${orderId}: no se pudo pedir repartidor a la plataforma (${code}).`);
      await this.releaseClaim(orderId);
      return 'failed';
    }

    await this.db
      .updateTable('orders')
      .set({
        smarky_delivery_id: created.deliveryId,
        smarky_tracking_url: created.trackingUrl,
        smarky_delivery_status: created.status,
        updated_at: new Date(),
      })
      .where('id', '=', orderId)
      .execute();

    if (order.customer_id) {
      await this.sendTrackingMessage(client, {
        orderId,
        customerId: order.customer_id,
        orderNumber: shortOrderNumber(order.order_number),
        delivery: created,
      });
    }
    return 'dispatched';
  }

  /**
   * Link + código al cliente en el mismo WhatsApp, directo por el gateway. El código NO pasa por
   * notification_jobs (guardaría el texto en la base) ni por los logs. Si el envío falla se
   * reemite un código nuevo y se reintenta una vez. Si vuelve a fallar, el link sale por
   * notification_jobs (con reintentos) SIN código: el código se pierde, nunca se persiste.
   */
  private async sendTrackingMessage(
    client: SmarkyClient,
    input: { orderId: string; customerId: string; orderNumber: string; delivery: SmarkyDeliveryCreated },
  ): Promise<void> {
    let code: string | null = input.delivery.deliveryCode ?? null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (!code) code = await client.reissueCode(input.delivery.deliveryId);
        await this.gateway.sendWhatsappMessage({
          customerId: input.customerId,
          text: buildTrackingMessage({
            orderNumber: input.orderNumber,
            trackingUrl: input.delivery.trackingUrl,
            deliveryCode: code,
          }),
        });
        return;
      } catch (error) {
        this.logger.warn(
          `Pedido ${input.orderId}: no se pudo enviar el link de seguimiento (intento ${attempt}): ${(error as Error).message}`,
        );
        code = null; // el siguiente intento pide un código nuevo: el anterior se perdió con el mensaje
      }
    }
    try {
      await this.notifications.notifyNow({
        channel: 'whatsapp',
        kind: 'delivery_tracking',
        targetRef: input.orderId,
        payload: {
          customerId: input.customerId,
          text: buildTrackingMessage({
            orderNumber: input.orderNumber,
            trackingUrl: input.delivery.trackingUrl,
            deliveryCode: null,
          }),
        },
      });
      this.logger.warn(`Pedido ${input.orderId}: el link salió por la cola pero sin código de entrega.`);
    } catch (error) {
      this.logger.error(
        `Pedido ${input.orderId}: el cliente NO recibió el link ni el código (${(error as Error).message}). El link está en orders.smarky_tracking_url.`,
      );
    }
  }

  private async releaseClaim(orderId: string): Promise<void> {
    await this.db
      .updateTable('orders')
      .set({ smarky_delivery_status: null })
      .where('id', '=', orderId)
      .where('smarky_delivery_status', '=', 'requesting')
      .execute();
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { DeliveryService } from '../delivery/delivery.service';

/** Antigüedad máxima del pedido al que puede responder un pin suelto (igual que sarcoRestaurant). */
export const LOOSE_PIN_WINDOW_HOURS = 6;

export interface AttachCustomerLocationInput {
  /** Teléfono del cliente, solo dígitos (el del webhook de Kapso). */
  customerPhone: string;
  latitude: number;
  longitude: number;
}

export type LocationAttachOutcome =
  /** Guardó las coordenadas en esta llamada. */
  | { result: 'attached'; orderId: string; quoted: boolean }
  /** El pedido ya tenía EXACTAMENTE estas coordenadas (reintento / pin repetido). */
  | { result: 'already_attached'; orderId: string; quoted: boolean }
  /** El pedido ya tiene otras coordenadas: NO se sobrescriben. */
  | { result: 'location_conflict'; orderId: string }
  /** Ningún pedido de delivery de este teléfono esperaba ubicación. */
  | { result: 'no_order' };

/** Carrera de guardado sin desenlace estable: el llamador debe hacer fallar el evento para reintentarlo. */
export class LocationAttachRetryError extends Error {
  constructor() {
    super('location_attach_failed:concurrent_update');
    this.name = 'LocationAttachRetryError';
  }
}

/**
 * Adjunta el pin de ubicación que un cliente manda por WhatsApp al pedido de
 * delivery que lo estaba esperando. Puerto mínimo de `attachLooseLocation` de
 * sarcoRestaurant: sin `context.id` (Central no guarda el wamid de la petición
 * en el pedido), el pedido se encuentra por teléfono — el más reciente en
 * `awaiting_location`, dentro de las últimas 6 horas.
 *
 * - Atómico: el `UPDATE` exige `status='awaiting_location'` y coordenadas NULL,
 *   así que dos pines concurrentes no pueden reclamar el mismo pedido.
 * - Nunca sobrescribe: si ya hay coordenadas, iguales ⇒ `already_attached`,
 *   distintas ⇒ `location_conflict`.
 * - Tras adjuntar (o al reintentar un pedido que ya las tenía) cotiza el
 *   delivery SOLO si corresponde: pricing dinámico y cotización pendiente o
 *   fallida. `quoteForOrder` es idempotente y, si el pedido ya está pagado,
 *   dispara el aviso al grupo de motos.
 *
 * No toca el endpoint HTTP `OrdersService.attachLocation`.
 */
@Injectable()
export class LocationAttachService {
  private readonly logger = new Logger(LocationAttachService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly delivery: DeliveryService,
  ) {}

  async tryAttach(
    input: AttachCustomerLocationInput,
    now: Date = new Date(),
  ): Promise<LocationAttachOutcome> {
    if (!input.customerPhone) return { result: 'no_order' };

    const customer = await this.db
      .selectFrom('customers')
      .select('id')
      .where('phone', '=', input.customerPhone)
      .executeTakeFirst();
    if (!customer) return { result: 'no_order' };

    const since = new Date(now.getTime() - LOOSE_PIN_WINDOW_HOURS * 60 * 60 * 1000);
    const order = await this.db
      .selectFrom('orders')
      .select([
        'id',
        'delivery_pricing',
        'delivery_quote_status',
        'delivery_latitude',
        'delivery_longitude',
      ])
      .where('customer_id', '=', customer.id)
      .where('delivery_type', '=', 'delivery')
      .where('status', '=', 'awaiting_location')
      .where('created_at', '>=', since)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!order) return { result: 'no_order' };

    if (order.delivery_latitude !== null && order.delivery_longitude !== null) {
      return this.resolveExisting(order, input);
    }

    const claimed = await this.db
      .updateTable('orders')
      .set({
        delivery_latitude: input.latitude,
        delivery_longitude: input.longitude,
        updated_at: new Date(),
      })
      .where('id', '=', order.id)
      .where('status', '=', 'awaiting_location')
      .where('delivery_latitude', 'is', null)
      .where('delivery_longitude', 'is', null)
      .returning('id')
      .executeTakeFirst();

    if (!claimed) {
      // Perdió la carrera: relee para saber quién ganó y con qué coordenadas.
      const current = await this.db
        .selectFrom('orders')
        .select([
          'id',
          'status',
          'delivery_pricing',
          'delivery_quote_status',
          'delivery_latitude',
          'delivery_longitude',
        ])
        .where('id', '=', order.id)
        .executeTakeFirst();
      if (current && current.delivery_latitude !== null && current.delivery_longitude !== null) {
        return this.resolveExisting(current, input);
      }
      if (current && current.status !== 'awaiting_location') return { result: 'no_order' };
      throw new LocationAttachRetryError();
    }

    const quoted = await this.quoteIfDue(order);
    return { result: 'attached', orderId: order.id, quoted };
  }

  private async resolveExisting(
    order: {
      id: string;
      delivery_pricing: 'dynamic' | null;
      delivery_quote_status: string | null;
      delivery_latitude: number | null;
      delivery_longitude: number | null;
    },
    input: AttachCustomerLocationInput,
  ): Promise<LocationAttachOutcome> {
    if (
      order.delivery_latitude !== input.latitude ||
      order.delivery_longitude !== input.longitude
    ) {
      return { result: 'location_conflict', orderId: order.id };
    }
    // Reintento tras un fallo de cotización: las coordenadas ya están, falta cotizar.
    const quoted = await this.quoteIfDue(order);
    return { result: 'already_attached', orderId: order.id, quoted };
  }

  private async quoteIfDue(order: {
    id: string;
    delivery_pricing: 'dynamic' | null;
    delivery_quote_status: string | null;
  }): Promise<boolean> {
    const due =
      order.delivery_pricing === 'dynamic' &&
      (order.delivery_quote_status === 'pending' || order.delivery_quote_status === 'failed');
    if (!due) return false;
    await this.delivery.quoteForOrder(order.id);
    this.logger.log(`delivery_quote_after_location orderId=${order.id}`);
    return true;
  }
}

import { Inject, Injectable, NotImplementedException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { QuoteDeliveryDto } from './dto/quote-delivery.dto';

export interface DeliveryQuoteResponse {
  status: 'quoted' | 'manual_quote' | 'failed';
  distanceMeters: number | null;
  feeAmount: number | null;
}

/**
 * Cotización de delivery. ESQUELETO deliberado (ver orders.service.ts) — el
 * cupo/reuso de WhatsApp NO vive aquí (es rate-limiting del canal, ver nota
 * del plan bajo "Delivery"): este servicio solo cotiza.
 */
@Injectable()
export class DeliveryService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * POST /delivery/quotes (standalone). TODO fase de implementación:
   * 1. Envolver en IdempotencyService.run (mismo patrón que POST /orders).
   * 2. Medir distancia (Mapbox u origen equivalente) o reusar una medición
   *    reciente si aplica a este canal.
   * 3. Aplicar delivery_tariff_bands; por encima del techo (16km) -> status
   *    'manual_quote' en vez de calcular con banda.
   * 4. Persistir en delivery_quote_requests (incluye idempotency_key propio
   *    de esta tabla — columna unique, no la tabla genérica idempotency_keys,
   *    ver migración 1700000006000_delivery).
   */
  async quoteStandalone(
    _dto: QuoteDeliveryDto,
    _idempotencyKey: string,
  ): Promise<DeliveryQuoteResponse> {
    throw new NotImplementedException('POST /delivery/quotes pendiente.');
  }

  /**
   * POST /orders/:id/delivery/quote — TODO: aplica tarifa (bandas + techo
   * 16km + recargo por lluvia LEÍDO Y CONGELADO en la misma transacción que
   * escribe orders.delivery_surcharge_amount) o marca
   * orders.delivery_quote_status = 'pending_manual' si excede el techo.
   */
  async quoteForOrder(_orderId: string): Promise<DeliveryQuoteResponse> {
    throw new NotImplementedException('POST /orders/:id/delivery/quote pendiente.');
  }

  /** POST /orders/:id/delivery/quote/manual — staff fija el monto a mano. */
  async setManualQuote(_orderId: string, _amount: number): Promise<DeliveryQuoteResponse> {
    throw new NotImplementedException('POST /orders/:id/delivery/quote/manual pendiente.');
  }
}

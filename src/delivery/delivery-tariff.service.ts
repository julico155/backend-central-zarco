import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Kysely, Transaction } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { DomainException } from '../common/exceptions/domain-exception';

export type DeliveryFee =
  | { ok: true; amount: number; bandIndex: number }
  | { ok: false; reason: 'manual_quote' | 'invalid_distance' };

/**
 * Bandas de tarifa: fuente única en `delivery_tariff_bands` (una tabla, no
 * duplicada en SQL + TypeScript como en el diseño anterior). Banda k cubre
 * `((k-1)*1000, k*1000]` metros, ordenadas por band_index ascendente.
 */
@Injectable()
export class DeliveryTariffService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async getBands(executor: Kysely<Database> | Transaction<Database> = this.db) {
    const bands = await executor
      .selectFrom('delivery_tariff_bands')
      .selectAll()
      .orderBy('band_index', 'asc')
      .execute();

    if (bands.length === 0) {
      throw new DomainException(
        'delivery_tariff_not_configured',
        HttpStatus.INTERNAL_SERVER_ERROR,
        'No hay bandas de tarifa de delivery configuradas.',
      );
    }
    return bands;
  }

  /** Techo automático: distancia máxima cubierta por la última banda. */
  async maxAutomaticMeters(
    executor: Kysely<Database> | Transaction<Database> = this.db,
  ): Promise<number> {
    const bands = await this.getBands(executor);
    return bands[bands.length - 1].max_distance_meters;
  }

  async feeForMeters(
    meters: number,
    executor: Kysely<Database> | Transaction<Database> = this.db,
  ): Promise<DeliveryFee> {
    if (!Number.isFinite(meters) || meters < 0) {
      return { ok: false, reason: 'invalid_distance' };
    }

    const bands = await this.getBands(executor);
    const maxMeters = bands[bands.length - 1].max_distance_meters;
    if (meters > maxMeters) {
      return { ok: false, reason: 'manual_quote' };
    }

    const band = bands.find((b) => meters <= b.max_distance_meters);
    if (!band) {
      return { ok: false, reason: 'invalid_distance' };
    }
    return { ok: true, amount: Number(band.fee_amount), bandIndex: band.band_index };
  }
}

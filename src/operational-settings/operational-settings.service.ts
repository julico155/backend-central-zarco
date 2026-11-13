import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { UpdateOperationalSettingsDto } from './dto/update-operational-settings.dto';
import { computeServiceStatus, ServiceStatus } from './service-status';

export interface OperationalSettingsResponse {
  rainSurchargeEnabled: boolean;
  rainSurchargeAmount: number;
  /** Margen ancho de cordura, no el horario preciso — ver comentario en OperationalSettingsTable. */
  businessOpensHour: number;
  businessClosesHour: number;
  restaurantLatitude: number | null;
  restaurantLongitude: number | null;
  /** Horario exacto que ve el cliente. */
  scheduleOpensHour: number;
  scheduleClosesHour: number;
  closedMessage: string;
  extendedMessage: string;
  /** Regla fija: ¿se puede mezclar una promoción con productos sueltos? */
  allowPromoWithItems: boolean;
  /** Modos temporales — vuelven solos a su valor normal a `dailyResetHour`. */
  cashEnabled: boolean;
  extendedServiceEnabled: boolean;
  manuallyClosed: boolean;
  queueEnabled: boolean;
  queueCapacity: number;
  queueReleaseBatch: number;
  dailyResetHour: number;
}

type SettingsRow = Awaited<ReturnType<OperationalSettingsService['getRow']>>;

/**
 * Horario de atención + recargo por lluvia + coordenadas del restaurante +
 * modos operativos (efectivo, cerrado, seguimos atendiendo, cola) — fila
 * única (id = true). El gate de horario (invariante 7), la medición de
 * distancia de delivery y la cotización (que congela el recargo en la misma
 * transacción) leen de aquí.
 */
@Injectable()
export class OperationalSettingsService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async get(): Promise<OperationalSettingsResponse> {
    const row = await this.getRow();
    return toResponse(row);
  }

  /** Fila cruda tal como está en BD — para consumo interno de otros módulos (delivery, orders). */
  async getRow() {
    return this.db
      .selectFrom('operational_settings')
      .selectAll()
      .where('id', '=', true)
      .executeTakeFirstOrThrow();
  }

  /** Estado calculado (¿atendemos?, ¿por qué?, textos para el cliente, reglas) — una sola fuente para agente, menú y POS. */
  async getServiceStatus(now: Date = new Date()): Promise<ServiceStatus> {
    return computeServiceStatus(await this.getRow(), now);
  }

  async update(dto: UpdateOperationalSettingsDto): Promise<OperationalSettingsResponse> {
    const row = await this.db
      .updateTable('operational_settings')
      .set({
        ...(dto.rainSurchargeEnabled !== undefined
          ? { rain_surcharge_enabled: dto.rainSurchargeEnabled }
          : {}),
        ...(dto.rainSurchargeAmount !== undefined
          ? { rain_surcharge_amount: dto.rainSurchargeAmount.toFixed(2) }
          : {}),
        ...(dto.businessOpensHour !== undefined
          ? { business_opens_hour: dto.businessOpensHour }
          : {}),
        ...(dto.businessClosesHour !== undefined
          ? { business_closes_hour: dto.businessClosesHour }
          : {}),
        ...(dto.restaurantLatitude !== undefined
          ? { restaurant_latitude: dto.restaurantLatitude }
          : {}),
        ...(dto.restaurantLongitude !== undefined
          ? { restaurant_longitude: dto.restaurantLongitude }
          : {}),
        ...(dto.scheduleOpensHour !== undefined ? { schedule_opens_hour: dto.scheduleOpensHour } : {}),
        ...(dto.scheduleClosesHour !== undefined ? { schedule_closes_hour: dto.scheduleClosesHour } : {}),
        ...(dto.closedMessage !== undefined ? { closed_message: dto.closedMessage.trim() } : {}),
        ...(dto.extendedMessage !== undefined ? { extended_message: dto.extendedMessage.trim() } : {}),
        ...(dto.allowPromoWithItems !== undefined ? { allow_promo_with_items: dto.allowPromoWithItems } : {}),
        ...(dto.cashEnabled !== undefined ? { cash_enabled: dto.cashEnabled } : {}),
        ...(dto.extendedServiceEnabled !== undefined
          ? { extended_service_enabled: dto.extendedServiceEnabled }
          : {}),
        ...(dto.manuallyClosed !== undefined ? { manually_closed: dto.manuallyClosed } : {}),
        ...(dto.queueEnabled !== undefined ? { queue_enabled: dto.queueEnabled } : {}),
        ...(dto.queueCapacity !== undefined ? { queue_capacity: dto.queueCapacity } : {}),
        ...(dto.queueReleaseBatch !== undefined ? { queue_release_batch: dto.queueReleaseBatch } : {}),
        ...(dto.dailyResetHour !== undefined ? { daily_reset_hour: dto.dailyResetHour } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', true)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toResponse(row);
  }
}

function toResponse(row: SettingsRow): OperationalSettingsResponse {
  return {
    rainSurchargeEnabled: row.rain_surcharge_enabled,
    rainSurchargeAmount: Number(row.rain_surcharge_amount),
    businessOpensHour: row.business_opens_hour,
    businessClosesHour: row.business_closes_hour,
    restaurantLatitude: row.restaurant_latitude,
    restaurantLongitude: row.restaurant_longitude,
    scheduleOpensHour: row.schedule_opens_hour,
    scheduleClosesHour: row.schedule_closes_hour,
    closedMessage: row.closed_message,
    extendedMessage: row.extended_message,
    allowPromoWithItems: row.allow_promo_with_items,
    cashEnabled: row.cash_enabled,
    extendedServiceEnabled: row.extended_service_enabled,
    manuallyClosed: row.manually_closed,
    queueEnabled: row.queue_enabled,
    queueCapacity: row.queue_capacity,
    queueReleaseBatch: row.queue_release_batch,
    dailyResetHour: row.daily_reset_hour,
  };
}

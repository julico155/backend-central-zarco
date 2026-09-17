import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { UpdateOperationalSettingsDto } from './dto/update-operational-settings.dto';

export interface OperationalSettingsResponse {
  rainSurchargeEnabled: boolean;
  rainSurchargeAmount: number;
  /** Margen ancho de cordura, no el horario preciso — ver comentario en OperationalSettingsTable. */
  businessOpensHour: number;
  businessClosesHour: number;
  restaurantLatitude: number | null;
  restaurantLongitude: number | null;
}

/**
 * Horario de atención + recargo por lluvia + coordenadas del restaurante —
 * fila única (id = true). El gate de horario (invariante 7), la medición de
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
        updated_at: new Date(),
      })
      .where('id', '=', true)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toResponse(row);
  }
}

function toResponse(row: {
  rain_surcharge_enabled: boolean;
  rain_surcharge_amount: string;
  business_opens_hour: number;
  business_closes_hour: number;
  restaurant_latitude: number | null;
  restaurant_longitude: number | null;
}): OperationalSettingsResponse {
  return {
    rainSurchargeEnabled: row.rain_surcharge_enabled,
    rainSurchargeAmount: Number(row.rain_surcharge_amount),
    businessOpensHour: row.business_opens_hour,
    businessClosesHour: row.business_closes_hour,
    restaurantLatitude: row.restaurant_latitude,
    restaurantLongitude: row.restaurant_longitude,
  };
}

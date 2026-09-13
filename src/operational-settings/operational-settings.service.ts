import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { UpdateOperationalSettingsDto } from './dto/update-operational-settings.dto';

export interface OperationalSettingsResponse {
  rainSurchargeEnabled: boolean;
  rainSurchargeAmount: number;
  businessOpensHour: number;
  businessClosesHour: number;
  lateReviewClosesHour: number;
}

/**
 * Horario de atención + recargo por lluvia — fila única (id = true).
 * El gate de horario (invariante 7) y la cotización de delivery (que congela
 * el recargo en la misma transacción) leen de aquí.
 */
@Injectable()
export class OperationalSettingsService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async get(): Promise<OperationalSettingsResponse> {
    const row = await this.db
      .selectFrom('operational_settings')
      .selectAll()
      .where('id', '=', true)
      .executeTakeFirstOrThrow();
    return toResponse(row);
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
        ...(dto.lateReviewClosesHour !== undefined
          ? { late_review_closes_hour: dto.lateReviewClosesHour }
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
  late_review_closes_hour: number;
}): OperationalSettingsResponse {
  return {
    rainSurchargeEnabled: row.rain_surcharge_enabled,
    rainSurchargeAmount: Number(row.rain_surcharge_amount),
    businessOpensHour: row.business_opens_hour,
    businessClosesHour: row.business_closes_hour,
    lateReviewClosesHour: row.late_review_closes_hour,
  };
}

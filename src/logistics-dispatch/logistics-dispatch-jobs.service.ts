import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transaction } from 'kysely';
import { AppConfig } from '../config/configuration';
import { Database } from '../database/types';
import {
  buildCreateLogisticsDeliveryRequest,
  CreateLogisticsDeliveryRequest,
  LOGISTICS_SOURCE_SYSTEM,
} from './logistics-delivery.mapper';

export interface EnqueueConfirmedDeliveryInput {
  order: {
    id: string;
    customer_name: string;
    customer_id: string | null;
    notes: string | null;
    delivery_base_amount: string;
    delivery_surcharge_amount: string;
    delivery_latitude: number | null;
    delivery_longitude: number | null;
    dropoff_address: string | null;
  };
  customerPhone: string | null;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
}

@Injectable()
export class LogisticsDispatchJobsService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async enqueueConfirmedDelivery(
    trx: Transaction<Database>,
    input: EnqueueConfirmedDeliveryInput,
  ): Promise<void> {
    const logistics = this.config.get('logisticsDispatch', { infer: true });
    if (!logistics.enabled) return;

    const payload = buildCreateLogisticsDeliveryRequest({
      logistics,
      order: {
        id: input.order.id,
        customerName: input.order.customer_name,
        customerNotes: input.order.notes,
        deliveryBaseAmount: input.order.delivery_base_amount,
        deliverySurchargeAmount: input.order.delivery_surcharge_amount,
        dropoffAddress: input.order.dropoff_address,
        dropoffLatitude: input.order.delivery_latitude,
        dropoffLongitude: input.order.delivery_longitude,
      },
      customerPhone: input.customerPhone,
      pickupLatitude: input.pickupLatitude,
      pickupLongitude: input.pickupLongitude,
    });

    await trx
      .insertInto('logistics_dispatch_jobs')
      .values({
        order_id: input.order.id,
        source_system: LOGISTICS_SOURCE_SYSTEM,
        external_order_id: input.order.id,
        payload: JSON.stringify(payload),
      })
      .onConflict((oc) => oc.column('order_id').doNothing())
      .execute();
  }
}

export type { CreateLogisticsDeliveryRequest };

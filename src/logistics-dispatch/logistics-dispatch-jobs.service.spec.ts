import { ConfigService } from '@nestjs/config';
import { Transaction } from 'kysely';
import { AppConfig } from '../config/configuration';
import { Database } from '../database/types';
import { LogisticsDispatchJobsService } from './logistics-dispatch-jobs.service';

const order = {
  id: 'order-a',
  customer_id: null,
  customer_name: 'Ana',
  notes: null,
  delivery_base_amount: '10.00',
  delivery_surcharge_amount: '2.00',
  delivery_latitude: -17.78,
  delivery_longitude: -63.18,
  dropoff_address: 'Calle 1',
};

describe('LogisticsDispatchJobsService', () => {
  it('does not enqueue when dispatch is disabled', async () => {
    const insertInto = jest.fn();
    const service = serviceWith({ enabled: false });

    await service.enqueueConfirmedDelivery({ insertInto } as unknown as Transaction<Database>, {
      order,
      customerPhone: null,
      pickupLatitude: -17.77,
      pickupLongitude: -63.17,
    });

    expect(insertInto).not.toHaveBeenCalled();
  });

  it('enqueues an idempotent snapshot when dispatch is enabled', async () => {
    const values = jest.fn();
    const doNothing = jest.fn();
    const insertInto = jest.fn(() => {
      const chain = {
        values: (value: unknown) => {
          values(value);
          return chain;
        },
        onConflict: (
          callback: (oc: { column: (name: string) => { doNothing: () => void } }) => void,
        ) => {
          callback({ column: () => ({ doNothing }) });
          return chain;
        },
        execute: jest.fn().mockResolvedValue([]),
      };
      return chain;
    });
    const service = serviceWith({ enabled: true });

    await service.enqueueConfirmedDelivery({ insertInto } as unknown as Transaction<Database>, {
      order,
      customerPhone: '+59170000000',
      pickupLatitude: -17.77,
      pickupLongitude: -63.17,
    });

    expect(insertInto).toHaveBeenCalledWith('logistics_dispatch_jobs');
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: order.id,
        source_system: 'zarco-orders-core',
        external_order_id: order.id,
        payload: expect.any(String),
      }),
    );
    expect(JSON.parse(values.mock.calls[0][0].payload)).toMatchObject({
      deliveryFee: 12,
      customerPhone: '+59170000000',
    });
    expect(doNothing).toHaveBeenCalled();
  });

  it('uses the same conflict-safe order key when enqueue is repeated', async () => {
    const doNothing = jest.fn();
    const insertInto = jest.fn(() => {
      const chain = {
        values: () => chain,
        onConflict: (
          callback: (oc: { column: (name: string) => { doNothing: () => void } }) => void,
        ) => {
          callback({ column: () => ({ doNothing }) });
          return chain;
        },
        execute: jest.fn().mockResolvedValue([]),
      };
      return chain;
    });
    const service = serviceWith({ enabled: true });
    const trx = { insertInto } as unknown as Transaction<Database>;
    const input = {
      order,
      customerPhone: null,
      pickupLatitude: -17.77,
      pickupLongitude: -63.17,
    };

    await service.enqueueConfirmedDelivery(trx, input);
    await service.enqueueConfirmedDelivery(trx, input);

    expect(insertInto).toHaveBeenCalledTimes(2);
    expect(doNothing).toHaveBeenCalledTimes(2);
  });
});

function serviceWith(overrides: { enabled: boolean }): LogisticsDispatchJobsService {
  const logisticsDispatch = {
    enabled: overrides.enabled,
    baseUrl: '',
    apiToken: '',
    tenantId: 'tenant-a',
    restaurantId: 'restaurant-a',
    branchId: 'branch-a',
    pickupAddress: null,
    requestTimeoutMs: 5000,
  };
  return new LogisticsDispatchJobsService({
    get: () => logisticsDispatch,
  } as unknown as ConfigService<AppConfig, true>);
}

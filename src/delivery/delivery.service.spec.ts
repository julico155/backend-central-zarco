import { DeliveryService } from './delivery.service';

const order = {
  id: 'order-a',
  customer_id: 'customer-a',
  customer_name: 'Ana',
  notes: 'Portón negro',
  delivery_type: 'delivery',
  delivery_pricing: 'dynamic',
  delivery_quote_status: 'pending',
  delivery_latitude: -17.78,
  delivery_longitude: -63.18,
  dropoff_address: 'Av. Siempre Viva 123',
  delivery_distance_meters: null,
  delivery_base_amount: null,
  delivery_surcharge_amount: '0.00',
  subtotal_amount: '100.00',
  total_amount: '100.00',
  status: 'awaiting_location',
  confirmed_at: null,
};

describe('DeliveryService Logistics outbox', () => {
  it('enqueues the automatic quote snapshot in the confirming transaction', async () => {
    const harness = transactionHarness(order);
    const jobs = { enqueueConfirmedDelivery: jest.fn().mockResolvedValue(undefined) };
    const service = createService(harness, jobs, { fee: { ok: true, amount: 12, bandIndex: 1 } });

    await service.quoteForOrder(order.id);

    expect(jobs.enqueueConfirmedDelivery).toHaveBeenCalledWith(
      harness.trx,
      expect.objectContaining({
        order: expect.objectContaining({
          id: order.id,
          delivery_base_amount: '12.00',
          delivery_surcharge_amount: '2.00',
        }),
        customerPhone: '+59170000000',
      }),
    );
    expect(harness.committedUpdates).toHaveLength(1);
  });

  it('enqueues the manual quote snapshot in the confirming transaction', async () => {
    const manualOrder = {
      ...order,
      delivery_quote_status: 'pending_manual',
      delivery_distance_meters: 2_000,
    };
    const harness = transactionHarness(manualOrder);
    const jobs = { enqueueConfirmedDelivery: jest.fn().mockResolvedValue(undefined) };
    const service = createService(harness, jobs, { maxAutomaticMeters: 1_000 });

    await service.setManualQuote(order.id, 20);

    expect(jobs.enqueueConfirmedDelivery).toHaveBeenCalledWith(
      harness.trx,
      expect.objectContaining({
        order: expect.objectContaining({
          delivery_base_amount: '20.00',
          delivery_surcharge_amount: '2.00',
        }),
      }),
    );
    expect(harness.committedUpdates).toHaveLength(1);
  });

  it('does not enqueue a pickup order', async () => {
    const harness = transactionHarness({ ...order, delivery_type: 'pickup' });
    const jobs = { enqueueConfirmedDelivery: jest.fn() };
    const service = createService(harness, jobs, { fee: { ok: true, amount: 12, bandIndex: 1 } });

    await expect(service.quoteForOrder(order.id)).rejects.toThrow('no es de delivery');

    expect(jobs.enqueueConfirmedDelivery).not.toHaveBeenCalled();
    expect(harness.committedUpdates).toHaveLength(0);
  });

  it('rolls back the order confirmation when outbox persistence fails', async () => {
    const harness = transactionHarness(order);
    const jobs = {
      enqueueConfirmedDelivery: jest.fn().mockRejectedValue(new Error('outbox insert failed')),
    };
    const service = createService(harness, jobs, { fee: { ok: true, amount: 12, bandIndex: 1 } });

    await expect(service.quoteForOrder(order.id)).rejects.toThrow('outbox insert failed');

    expect(jobs.enqueueConfirmedDelivery).toHaveBeenCalledTimes(1);
    expect(harness.committedUpdates).toHaveLength(0);
  });
});

function createService(
  harness: ReturnType<typeof transactionHarness>,
  jobs: { enqueueConfirmedDelivery: jest.Mock },
  options: {
    fee?: { ok: true; amount: number; bandIndex: number };
    maxAutomaticMeters?: number;
  },
): DeliveryService {
  return new DeliveryService(
    harness.database as never,
    {
      feeForMeters: jest
        .fn()
        .mockResolvedValue(options.fee ?? { ok: true, amount: 12, bandIndex: 1 }),
      maxAutomaticMeters: jest.fn().mockResolvedValue(options.maxAutomaticMeters ?? 1_000),
    } as never,
    {
      metersBetween: jest.fn().mockResolvedValue({ meters: 500, source: 'straight_line' }),
    } as never,
    {
      getRow: jest.fn().mockResolvedValue({
        restaurant_latitude: -17.77,
        restaurant_longitude: -63.17,
        rain_surcharge_enabled: true,
        rain_surcharge_amount: '2.00',
      }),
    } as never,
    jobs as never,
  );
}

function transactionHarness(
  currentOrder: Omit<typeof order, 'delivery_distance_meters'> & {
    delivery_distance_meters: number | null;
  },
) {
  const committedUpdates: unknown[] = [];
  let transactionUpdates: unknown[] = [];
  const trx = {
    selectFrom: (table: string) => {
      const query = {
        selectAll: () => query,
        select: () => query,
        where: () => query,
        forUpdate: () => query,
        executeTakeFirst: async () =>
          table === 'orders'
            ? currentOrder
            : table === 'customers'
              ? { phone: '+59170000000' }
              : undefined,
      };
      return query;
    },
    updateTable: () => {
      const update = {
        set: (values: unknown) => {
          transactionUpdates.push(values);
          return update;
        },
        where: () => update,
        execute: jest.fn().mockResolvedValue([]),
      };
      return update;
    },
  };
  const database = {
    transaction: () => ({
      execute: async (callback: (transaction: typeof trx) => Promise<unknown>) => {
        transactionUpdates = [];
        try {
          const result = await callback(trx);
          committedUpdates.push(...transactionUpdates);
          return result;
        } finally {
          transactionUpdates = [];
        }
      },
    }),
  };

  return { database, trx, committedUpdates };
}

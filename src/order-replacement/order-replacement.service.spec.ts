import { OrderReplacementService } from './order-replacement.service';

/** Query builder falso: cualquier método de encadenado se devuelve a sí mismo; los terminales resuelven `result`. */
function chain(result: unknown) {
  const obj: Record<string, jest.Mock> = {};
  for (const method of ['select', 'selectAll', 'where', 'orderBy', 'limit', 'forUpdate', 'set', 'innerJoin']) {
    obj[method] = jest.fn(() => obj);
  }
  obj.execute = jest.fn().mockResolvedValue(Array.isArray(result) ? result : []);
  obj.executeTakeFirst = jest.fn().mockResolvedValue(result);
  obj.executeTakeFirstOrThrow = jest.fn().mockResolvedValue(result);
  return obj;
}

function tableRouter(byTable: Record<string, ReturnType<typeof chain>>) {
  return jest.fn((table: string) => byTable[table] ?? chain(undefined));
}

const customer = { id: 'customer-1' };

function createService(opts: {
  dbSelectFrom: jest.Mock;
  trxSelectFrom?: jest.Mock;
  trxUpdateTable?: jest.Mock;
  orders?: Partial<{
    createOrderInTransaction: jest.Mock;
    applyLocationLocked: jest.Mock;
    findById: jest.Mock;
    notifyOrderCreated: jest.Mock;
  }>;
}) {
  const trx = { selectFrom: opts.trxSelectFrom ?? jest.fn(), updateTable: opts.trxUpdateTable ?? jest.fn(() => chain(undefined)) };
  const db = { selectFrom: opts.dbSelectFrom, transaction: () => ({ execute: async (fn: (t: typeof trx) => unknown) => fn(trx) }) };
  const idempotency = {
    run: jest.fn(async ({ execute }: { execute: (t: typeof trx) => Promise<{ status: number; body: unknown }> }) => {
      const result = await execute(trx);
      return { body: result.body, status: result.status, created: true };
    }),
  };
  const operationalSettings = {
    getRow: jest.fn().mockResolvedValue({ business_opens_hour: 0, business_closes_hour: 23 }),
  };
  const cashRegister = { isOpen: jest.fn().mockResolvedValue(true) };
  const orders = {
    createOrderInTransaction: jest.fn().mockResolvedValue({ id: 'new-order' }),
    applyLocationLocked: jest.fn().mockResolvedValue({ decision: 'attach', quote: { result: 'applied' } }),
    findById: jest.fn().mockResolvedValue({ id: 'new-order' }),
    notifyOrderCreated: jest.fn().mockResolvedValue(undefined),
    ...opts.orders,
  };

  const service = new OrderReplacementService(
    db as never,
    idempotency as never,
    operationalSettings as never,
    cashRegister as never,
    orders as never,
  );
  return { service, trx, orders };
}

describe('OrderReplacementService.resolveReplaceable', () => {
  it('returns no_order when the phone has no customer', async () => {
    const { service } = createService({ dbSelectFrom: tableRouter({ customers: chain(undefined) }) });
    await expect(service.resolveReplaceable('+59170001234')).resolves.toEqual({ result: 'no_order' });
  });

  it('returns no_order when the customer has no active order', async () => {
    const { service } = createService({
      dbSelectFrom: tableRouter({ customers: chain(customer), orders: chain(undefined) }),
    });
    await expect(service.resolveReplaceable('+59170001234')).resolves.toEqual({ result: 'no_order' });
  });

  it('returns not_replaceable when the active order is already paid', async () => {
    const order = { id: 'order-1', order_number: 'ORD-0001', status: 'confirmed', payment_status: 'paid', delivery_type: 'pickup', delivery_latitude: null, delivery_longitude: null, notes: null };
    const { service } = createService({
      dbSelectFrom: tableRouter({
        customers: chain(customer),
        orders: chain(order),
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
      }),
    });
    await expect(service.resolveReplaceable('+59170001234')).resolves.toEqual({
      result: 'not_replaceable',
      reasonCode: 'already_paid',
    });
  });

  it('returns the cart (ids + quantities, no prices) for a replaceable order', async () => {
    const order = { id: 'order-1', order_number: 'ORD-0001', status: 'awaiting_location', payment_status: 'unpaid', delivery_type: 'delivery', delivery_latitude: null, delivery_longitude: null, notes: null };
    const items = [{ product_id: 'p1', quantity: 2, excluded_complements: ['quirquiña'] }];
    const promotions = [{ promotion_id: 'promo-1', combo_quantity: 1 }];
    const { service } = createService({
      dbSelectFrom: tableRouter({
        customers: chain(customer),
        orders: chain(order),
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
        order_items: chain(items),
        order_promotions: chain(promotions),
      }),
    });

    await expect(service.resolveReplaceable('+59170001234')).resolves.toEqual({
      result: 'replaceable',
      orderId: 'order-1',
      orderNumber: 'ORD-0001',
      status: 'awaiting_location',
      deliveryType: 'delivery',
      hasLocation: false,
      cart: {
        deliveryType: 'delivery',
        items: [{ productId: 'p1', quantity: 2, excludedComplements: ['quirquiña'] }],
        promotions: [{ promotionId: 'promo-1', quantity: 1 }],
      },
    });
  });
});

describe('OrderReplacementService.appendNote', () => {
  const dto = { customerPhone: '+59170001234', note: 'sin cebolla', sourceMessageId: 'wamid-1' };

  it('returns no_order when the phone has no customer', async () => {
    const { service } = createService({ dbSelectFrom: jest.fn(), trxSelectFrom: tableRouter({ customers: chain(undefined) }) });
    await expect(service.appendNote(dto, 'whatsapp-gateway')).resolves.toEqual({ result: 'no_order' });
  });

  it('returns not_allowed when the active order already has a money signal', async () => {
    const order = { id: 'order-1', status: 'confirmed', payment_status: 'unpaid', notes: null };
    const { service, trx } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({
        customers: chain(customer),
        orders: chain(order),
        bank_qr_charges: chain([{ status: 'paid_unapplied', paid_detected_at: new Date() }]),
        payment_attempts: chain([]),
      }),
    });
    await expect(service.appendNote(dto, 'whatsapp-gateway')).resolves.toEqual({
      result: 'not_allowed',
      reasonCode: 'payment_in_progress',
    });
    expect(trx.updateTable).not.toHaveBeenCalled();
  });

  it('appends to existing notes and saves', async () => {
    const order = { id: 'order-1', status: 'confirmed', payment_status: 'unpaid', notes: 'ya tenía una nota' };
    const updateOrders = chain(undefined);
    const { service, trx } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({
        customers: chain(customer),
        orders: chain(order),
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
      }),
      trxUpdateTable: jest.fn(() => updateOrders),
    });

    await expect(service.appendNote(dto, 'whatsapp-gateway')).resolves.toEqual({ result: 'saved' });
    expect(trx.updateTable).toHaveBeenCalledWith('orders');
    expect(updateOrders.set).toHaveBeenCalledWith(
      expect.objectContaining({ notes: 'ya tenía una nota\nsin cebolla' }),
    );
  });
});

describe('OrderReplacementService.createReplacement', () => {
  const dto = {
    customerPhone: '+59170001234',
    orderId: 'order-1',
    customerName: 'Juan Pérez',
    deliveryType: 'delivery' as const,
    paymentMethod: 'qr' as const,
    items: [{ productId: 'p1', quantity: 2 }],
    promotions: [],
  };

  it('rejects when the resolved customer does not own orderId (never trusts the client-supplied id blindly)', async () => {
    const oldOrder = { id: 'order-1', customer_id: 'someone-else', status: 'confirmed', payment_status: 'unpaid', delivery_type: 'delivery', delivery_latitude: null, delivery_longitude: null };
    const { service, orders } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({
        customers: chain(customer),
        orders: chain(oldOrder),
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
      }),
    });

    const result = await service.createReplacement(dto, 'idem-1', 'whatsapp-gateway');
    expect(result).toEqual({ httpStatus: 409, body: { result: 'order_customer_mismatch' } });
    expect(orders.createOrderInTransaction).not.toHaveBeenCalled();
  });

  it('rejects when the order already has a money signal, without cancelling it', async () => {
    const oldOrder = { id: 'order-1', customer_id: 'customer-1', status: 'confirmed', payment_status: 'paid', delivery_type: 'delivery', delivery_latitude: null, delivery_longitude: null };
    const { service, trx, orders } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({
        customers: chain(customer),
        orders: chain(oldOrder),
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
      }),
    });

    const result = await service.createReplacement(dto, 'idem-1', 'whatsapp-gateway');
    expect(result).toEqual({ httpStatus: 409, body: { result: 'not_replaceable', reasonCode: 'already_paid' } });
    expect(trx.updateTable).not.toHaveBeenCalled();
    expect(orders.createOrderInTransaction).not.toHaveBeenCalled();
  });

  it('cancels the old order, creates the new one, links both, reuses location, and notifies after commit', async () => {
    const oldOrder = {
      id: 'order-1',
      customer_id: 'customer-1',
      status: 'confirmed',
      payment_status: 'unpaid',
      delivery_type: 'delivery',
      delivery_latitude: -17.78,
      delivery_longitude: -63.18,
    };
    const updateOrders = chain(undefined);
    const { service, trx, orders } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({
        customers: chain(customer),
        orders: chain(oldOrder), // reused for the FOR UPDATE lookup AND the post-create re-select of the new row
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
      }),
      trxUpdateTable: jest.fn(() => updateOrders),
    });

    const result = await service.createReplacement(dto, 'idem-1', 'whatsapp-gateway');

    expect(result.httpStatus).toBe(201);
    expect(result.body).toEqual({ result: 'replaced', orderId: 'new-order', replacedOrderId: 'order-1' });

    // Vieja cancelada
    expect(updateOrders.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled', status_updated_by: 'system:replacement' }),
    );
    // Nueva creada reusando la MISMA lógica autoritativa que POST /orders
    expect(orders.createOrderInTransaction).toHaveBeenCalledWith(
      trx,
      expect.objectContaining({ customerId: 'customer-1', channel: 'whatsapp', deliveryType: 'delivery' }),
    );
    // Vinculadas en ambos sentidos
    expect(updateOrders.set).toHaveBeenCalledWith(
      expect.objectContaining({ replaces_order_id: 'order-1' }),
    );
    expect(updateOrders.set).toHaveBeenCalledWith(
      expect.objectContaining({ replaced_by_order_id: 'new-order' }),
    );
    // Ubicación reusada (recotizada, nunca copiado el monto)
    expect(orders.applyLocationLocked).toHaveBeenCalledWith(
      trx,
      expect.objectContaining({ id: 'order-1' }),
      { latitude: -17.78, longitude: -63.18 },
    );
    // La notificación es post-commit (fuera de la transacción), best-effort
    await Promise.resolve();
    expect(orders.findById).toHaveBeenCalledWith('new-order');
    expect(orders.notifyOrderCreated).toHaveBeenCalled();
  });

  it('does not reuse location when switching delivery -> pickup', async () => {
    const oldOrder = {
      id: 'order-1',
      customer_id: 'customer-1',
      status: 'confirmed',
      payment_status: 'unpaid',
      delivery_type: 'delivery',
      delivery_latitude: -17.78,
      delivery_longitude: -63.18,
    };
    const { service, orders } = createService({
      dbSelectFrom: jest.fn(),
      trxSelectFrom: tableRouter({
        customers: chain(customer),
        orders: chain(oldOrder),
        bank_qr_charges: chain([]),
        payment_attempts: chain([]),
      }),
    });

    await service.createReplacement({ ...dto, deliveryType: 'pickup' }, 'idem-1', 'whatsapp-gateway');
    expect(orders.applyLocationLocked).not.toHaveBeenCalled();
  });
});

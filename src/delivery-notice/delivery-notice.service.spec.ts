import { DeliveryNoticeService } from './delivery-notice.service';

type Row = Record<string, unknown>;

interface Fixtures {
  order: Row | undefined;
  items: Row[];
  promotions: Row[];
  customer: Row | undefined;
  proof: Row | undefined;
}

/** Cadena Kysely mínima: cada `selectFrom(tabla)` responde con el fixture de esa tabla. */
function fakeDb(fixtures: Fixtures) {
  const tables: Record<string, () => { many: Row[]; one: Row | undefined }> = {
    orders: () => ({ many: [], one: fixtures.order }),
    order_items: () => ({ many: fixtures.items, one: fixtures.items[0] }),
    order_promotions: () => ({ many: fixtures.promotions, one: fixtures.promotions[0] }),
    customers: () => ({ many: [], one: fixtures.customer }),
    payment_proofs: () => ({ many: [], one: fixtures.proof }),
  };
  return {
    selectFrom(table: string) {
      const data = tables[table]();
      const chain = {
        select: () => chain,
        selectAll: () => chain,
        where: () => chain,
        orderBy: () => chain,
        execute: async () => data.many,
        executeTakeFirst: async () => data.one,
      };
      return chain;
    },
  };
}

const ORDER_ID = '00000000-0000-0000-0000-0000000000aa';

function paidQuotedOrder(overrides: Row = {}): Row {
  return {
    id: ORDER_ID,
    order_number: 'ORD-260902-009',
    customer_id: 'cust-1',
    customer_name: 'Ana',
    delivery_type: 'delivery',
    payment_method: 'qr',
    payment_status: 'paid',
    delivery_quote_status: 'quoted',
    delivery_latitude: -17.78,
    delivery_longitude: -63.18,
    delivery_distance_meters: 5762,
    delivery_base_amount: '10.00',
    delivery_surcharge_amount: '3.00',
    subtotal_amount: '48.00',
    total_amount: '61.00',
    delivery_fee_paid: null,
    notes: 'sin cebolla',
    ...overrides,
  };
}

function setup(orderOverrides: Row | null = {}, telegram = { botToken: 'tok', chatId: '-100' }) {
  const fixtures: Fixtures = {
    order: orderOverrides === null ? undefined : paidQuotedOrder(orderOverrides),
    items: [{ product_name_snapshot: 'Lomito', quantity: 1 }],
    promotions: [
      {
        combo_quantity: 1,
        components_snapshot: [
          { productId: 'p', code: 'LOM', name: 'Lomito', unitPrice: 20, quantity: 1 },
          { productId: 'q', code: 'COC', name: 'Coca', unitPrice: 5, quantity: 1 },
        ],
      },
    ],
    customer: { phone: '59170000000' },
    proof: undefined,
  };
  const notifications = { notifyNow: jest.fn().mockResolvedValue(undefined) };
  const config = {
    get: jest.fn().mockReturnValue({ ...telegram, handoffChatId: '', apiBaseUrl: '' }),
  };
  const service = new DeliveryNoticeService(
    fakeDb(fixtures) as never,
    notifications as never,
    config as never,
  );
  return { service, notifications, fixtures };
}

describe('DeliveryNoticeService.tryNotify — condición de emisión', () => {
  it('delivery + pagado + cotizado + con ubicación: encola delivery_notice con targetRef = id del pedido', async () => {
    const h = setup();

    await expect(h.service.tryNotify(ORDER_ID)).resolves.toBe('enqueued');

    expect(h.notifications.notifyNow).toHaveBeenCalledTimes(1);
    const job = h.notifications.notifyNow.mock.calls[0][0];
    expect(job).toMatchObject({
      channel: 'telegram',
      kind: 'delivery_notice',
      targetRef: ORDER_ID,
      payload: { chatRef: 'delivery-group', parseMode: 'HTML' },
    });
    expect(job.payload.text).toContain('ORD-009');
    expect(job.payload.text).toContain('Teléfono: https://wa.me/59170000000');
    // suelto + componentes del combo consolidados; envío = base + recargo
    expect(job.payload.text).toContain('Pedido (3 productos):\n  2x Lomito\n  1x Coca');
    expect(job.payload.text).toContain('Envío: Bs 13 · 5.8 km');
    expect(job.payload.text).toContain('COBRAR ENVÍO');
    expect(job.payload.text).toContain('NOTA DEL CLIENTE:\nsin cebolla');
  });

  it.each([
    ['no es delivery', { delivery_type: 'pickup' }],
    ['no está pagado (unpaid)', { payment_status: 'unpaid' }],
    ['pago en revisión', { payment_status: 'pending_review' }],
    ['pago rechazado', { payment_status: 'rejected' }],
    ['cotización pendiente', { delivery_quote_status: 'pending' }],
    ['cotización manual pendiente', { delivery_quote_status: 'pending_manual' }],
    ['sin latitud', { delivery_latitude: null }],
    ['sin longitud', { delivery_longitude: null }],
  ])('NO emite si %s', async (_label, override) => {
    const h = setup(override);

    await expect(h.service.tryNotify(ORDER_ID)).resolves.toBe('not_applicable');
    expect(h.notifications.notifyNow).not.toHaveBeenCalled();
  });

  it('pedido inexistente → order_not_found, sin envío', async () => {
    const h = setup(null);
    await expect(h.service.tryNotify(ORDER_ID)).resolves.toBe('order_not_found');
    expect(h.notifications.notifyNow).not.toHaveBeenCalled();
  });

  it('sin TELEGRAM_BOT_TOKEN/CHAT_ID queda apagado y no encola nada', async () => {
    const h = setup({}, { botToken: '', chatId: '' });
    await expect(h.service.tryNotify(ORDER_ID)).resolves.toBe('not_configured');
    expect(h.notifications.notifyNow).not.toHaveBeenCalled();
  });

  it('efectivo: el aviso lleva QUIERE EFECTIVO con el total a cobrar', async () => {
    const h = setup({ payment_method: 'cash' });
    await h.service.tryNotify(ORDER_ID);
    const text = h.notifications.notifyNow.mock.calls[0][0].payload.text as string;
    expect(text).toContain('<b>QUIERE EFECTIVO</b>');
    expect(text).toContain('TOTAL A COBRAR: Bs 61');
  });

  it('override humano true en la base → ENVÍO PAGADO; false → COBRAR ENVÍO; null → regla por defecto', async () => {
    const pagado = setup({ delivery_fee_paid: true });
    await pagado.service.tryNotify(ORDER_ID);
    expect(pagado.notifications.notifyNow.mock.calls[0][0].payload.text).toContain('ENVÍO PAGADO');

    const cobrar = setup({ delivery_fee_paid: false });
    cobrar.fixtures.proof = { analysis_amount_label: 'pago_total' };
    await cobrar.service.tryNotify(ORDER_ID);
    expect(cobrar.notifications.notifyNow.mock.calls[0][0].payload.text).toContain('COBRAR ENVÍO');
  });

  it('sin override, la etiqueta del comprobante pago_total → ENVÍO PAGADO', async () => {
    const h = setup();
    h.fixtures.proof = { analysis_amount_label: 'pago_total' };
    await h.service.tryNotify(ORDER_ID);
    expect(h.notifications.notifyNow.mock.calls[0][0].payload.text).toContain('ENVÍO PAGADO');
  });

  it('nunca lanza: si la cola falla devuelve error', async () => {
    const h = setup();
    h.notifications.notifyNow.mockRejectedValueOnce(new Error('db down'));
    await expect(h.service.tryNotify(ORDER_ID)).resolves.toBe('error');
  });

  it('llamarlo dos veces manda dos notifyNow con la MISMA clave (kind + targetRef): el dedupe lo hace notification_jobs', async () => {
    const h = setup();
    await h.service.tryNotify(ORDER_ID);
    await h.service.tryNotify(ORDER_ID);
    const keys = h.notifications.notifyNow.mock.calls.map(
      ([job]) => `${job.kind}:${job.targetRef}`,
    );
    expect(keys).toEqual([`delivery_notice:${ORDER_ID}`, `delivery_notice:${ORDER_ID}`]);
  });
});

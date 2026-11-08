import { DeliveryNoticesService } from './delivery-notices.service';

const pedido = {
  id: 'order-1',
  order_number: 'ORD-0007',
  customer_name: 'Juan Pérez',
  customer_phone: '59170000000',
  delivery_type: 'delivery',
  payment_method: 'qr',
  payment_status: 'paid',
  notes: null,
  delivery_quote_status: 'quoted',
  delivery_base_amount: '10',
  delivery_surcharge_amount: '3',
  subtotal_amount: '42',
  total_amount: '55',
  delivery_fee_paid: false,
  latitude: -17.78,
  longitude: -63.18,
  distance_meters: 4800,
};

function crear(smarky?: { enabled: boolean; dispatchForOrder: jest.Mock }) {
  const consulta = (resultado: unknown) => {
    const q: Record<string, jest.Mock> = {};
    for (const m of ['leftJoin', 'select', 'where']) q[m] = jest.fn(() => q);
    q.executeTakeFirst = jest.fn().mockResolvedValue(resultado);
    q.execute = jest.fn().mockResolvedValue([{ product_name_snapshot: 'Trancapecho', quantity: 1 }]);
    return q;
  };
  const db = {
    selectFrom: jest.fn((tabla: string) => {
      if (tabla === 'order_promotions') {
        const q = consulta(undefined);
        q.execute = jest.fn().mockResolvedValue([]);
        return q;
      }
      return consulta(pedido);
    }),
  };
  const notify = jest.fn().mockResolvedValue(undefined);
  const service = new DeliveryNoticesService(db as never, { notifyNow: notify } as never, smarky as never);
  return { service, notify };
}

describe('DeliveryNoticesService con la plataforma de reparto', () => {
  it('sin plataforma (proveedor interno) avisa al grupo exactamente como siempre', async () => {
    const { service, notify } = crear(undefined);
    await service.notifyConfirmed('order-1');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ channel: 'telegram', kind: 'delivery_notice' });
  });

  it('plataforma apagada (enabled=false): ni siquiera se consulta y el aviso sale igual', async () => {
    const smarky = { enabled: false, dispatchForOrder: jest.fn() };
    const { service, notify } = crear(smarky);
    await service.notifyConfirmed('order-1');
    expect(smarky.dispatchForOrder).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it.each(['dispatched', 'in_progress'])('si la plataforma toma el pedido (%s) NO se avisa al grupo propio', async (resultado) => {
    const smarky = { enabled: true, dispatchForOrder: jest.fn().mockResolvedValue(resultado) };
    const { service, notify } = crear(smarky);
    await service.notifyConfirmed('order-1');
    expect(smarky.dispatchForOrder).toHaveBeenCalledWith('order-1');
    expect(notify).not.toHaveBeenCalled();
  });

  it.each(['failed', 'skipped'])('si la plataforma falla o no aplica (%s) cae al aviso de siempre', async (resultado) => {
    const smarky = { enabled: true, dispatchForOrder: jest.fn().mockResolvedValue(resultado) };
    const { service, notify } = crear(smarky);
    await service.notifyConfirmed('order-1');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ kind: 'delivery_notice' });
  });

  it('no pide repartidor a la plataforma si el pedido no es elegible (QR sin pagar)', async () => {
    const smarky = { enabled: true, dispatchForOrder: jest.fn() };
    const { service } = crear(smarky);
    (service as unknown as { db: { selectFrom: jest.Mock } }).db.selectFrom.mockImplementationOnce(() => {
      const q: Record<string, jest.Mock> = {};
      for (const m of ['leftJoin', 'select', 'where']) q[m] = jest.fn(() => q);
      q.executeTakeFirst = jest.fn().mockResolvedValue({ ...pedido, payment_status: 'unpaid' });
      return q;
    });
    await service.notifyConfirmed('order-1');
    expect(smarky.dispatchForOrder).not.toHaveBeenCalled();
  });
});

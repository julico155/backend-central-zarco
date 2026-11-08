import { SmarkyTrackingService } from './smarky-tracking.service';

function crear(opciones: { cliente?: unknown; pedido?: unknown }) {
  const consultas: string[] = [];
  const db = {
    selectFrom: (tabla: string) => {
      consultas.push(tabla);
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'where', 'orderBy', 'limit']) b[m] = () => b;
      b.executeTakeFirst = async () => (tabla === 'customers' ? opciones.cliente : opciones.pedido);
      return b;
    },
  };
  return { service: new SmarkyTrackingService(db as never), consultas };
}

const pedido = { order_number: 'ORD-261107-276', smarky_tracking_url: 'https://seguimiento.test/seguir/x', smarky_delivery_status: 'in_transit' };

describe('SmarkyTrackingService', () => {
  it('devuelve número corto, link y estado del pedido en curso — y nada más', async () => {
    const { service } = crear({ cliente: { id: 'c1' }, pedido });
    const r = await service.findForPhone('59171234567');
    expect(r).toEqual({
      result: 'tracking',
      orderNumber: 'ORD-276',
      trackingUrl: 'https://seguimiento.test/seguir/x',
      deliveryStatus: 'in_transit',
    });
    expect(JSON.stringify(r)).not.toMatch(/code|codigo|código/i);
  });

  it('sin cliente o sin pedido con link responde no_tracking', async () => {
    await expect(crear({ cliente: undefined }).service.findForPhone('59171234567')).resolves.toEqual({ result: 'no_tracking' });
    await expect(crear({ cliente: { id: 'c1' }, pedido: undefined }).service.findForPhone('59171234567')).resolves.toEqual({ result: 'no_tracking' });
  });

  it('una entrega terminada o abandonada ya no tiene link útil', async () => {
    for (const estado of ['delivered', 'cancelled', 'failed']) {
      const { service } = crear({ cliente: { id: 'c1' }, pedido: { ...pedido, smarky_delivery_status: estado } });
      await expect(service.findForPhone('59171234567')).resolves.toEqual({ result: 'no_tracking' });
    }
  });
});

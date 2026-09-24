import {
  LOOSE_PIN_WINDOW_HOURS,
  LocationAttachRetryError,
  LocationAttachService,
} from './location-attach.service';

type Row = Record<string, unknown>;
type Cond = [string, string, unknown];

const NOW = new Date('2026-09-25T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);
const PHONE = '59170000000';

function matches(row: Row, [column, op, value]: Cond): boolean {
  const actual = row[column];
  if (op === 'is') return actual === value;
  if (op === '=') return actual === value;
  if (op === '>=') return (actual as Date).getTime() >= (value as Date).getTime();
  throw new Error(`operador no soportado: ${op}`);
}

/**
 * Kysely mínimo sobre tablas en memoria: evalúa los `where` de verdad, así el
 * claim atómico, la ventana de 6 h y el orden por antigüedad se prueban con la
 * misma semántica que en Postgres. Cada `execute` cede el turno (await) para
 * que dos llamadas concurrentes se intercalen.
 */
function fakeDb(tables: { customers: Row[]; orders: Row[] }) {
  const state = { failNextClaim: false, updates: 0 };

  function select(table: 'customers' | 'orders') {
    const conds: Cond[] = [];
    let order: 'desc' | null = null;
    let max = Infinity;
    const chain = {
      select: () => chain,
      where: (c: string, op: string, v: unknown) => (conds.push([c, op, v]), chain),
      orderBy: (_c: string, dir: 'desc') => ((order = dir), chain),
      limit: (n: number) => ((max = n), chain),
      executeTakeFirst: async () => {
        await Promise.resolve();
        let rows = tables[table].filter((r) => conds.every((c) => matches(r, c)));
        if (order === 'desc') {
          rows = [...rows].sort(
            (a, b) => (b.created_at as Date).getTime() - (a.created_at as Date).getTime(),
          );
        }
        return rows.slice(0, max)[0];
      },
    };
    return chain;
  }

  function update() {
    const conds: Cond[] = [];
    let values: Row = {};
    const chain = {
      set: (v: Row) => ((values = v), chain),
      where: (c: string, op: string, v: unknown) => (conds.push([c, op, v]), chain),
      returning: () => chain,
      executeTakeFirst: async () => {
        await Promise.resolve();
        if (state.failNextClaim) {
          state.failNextClaim = false;
          return undefined;
        }
        const row = tables.orders.find((r) => conds.every((c) => matches(r, c)));
        if (!row) return undefined;
        Object.assign(row, values);
        state.updates += 1;
        return { id: row.id };
      },
    };
    return chain;
  }

  const db = {
    selectFrom: (table: 'customers' | 'orders') => select(table),
    updateTable: () => update(),
  };
  return { db, state };
}

function order(overrides: Row = {}): Row {
  return {
    id: 'order-1',
    customer_id: 'cust-1',
    delivery_type: 'delivery',
    status: 'awaiting_location',
    delivery_pricing: 'dynamic',
    delivery_quote_status: 'pending',
    delivery_latitude: null,
    delivery_longitude: null,
    created_at: hoursAgo(1),
    ...overrides,
  };
}

function setup(orders: Row[] = [order()], customers: Row[] = [{ id: 'cust-1', phone: PHONE }]) {
  const tables = { customers, orders };
  const { db, state } = fakeDb(tables);
  const delivery = { quoteForOrder: jest.fn().mockResolvedValue({ result: 'applied' }) };
  const service = new LocationAttachService(db as never, delivery as never);
  return { service, tables, delivery, state };
}

const pin = (latitude = -17.78, longitude = -63.18) => ({
  customerPhone: PHONE,
  latitude,
  longitude,
});

describe('LocationAttachService — claim y cotización', () => {
  it('claim ganado: guarda las coordenadas en el pedido y cotiza una vez', async () => {
    const h = setup();

    const out = await h.service.tryAttach(pin(), NOW);

    expect(out).toEqual({ result: 'attached', orderId: 'order-1', quoted: true });
    expect(h.tables.orders[0]).toMatchObject({
      delivery_latitude: -17.78,
      delivery_longitude: -63.18,
    });
    expect(h.delivery.quoteForOrder).toHaveBeenCalledTimes(1);
    expect(h.delivery.quoteForOrder).toHaveBeenCalledWith('order-1');
  });

  it('claim perdido en concurrencia: dos pines distintos al mismo tiempo, gana uno y el otro es conflicto sin sobrescribir', async () => {
    const h = setup();

    const [a, b] = await Promise.all([
      h.service.tryAttach(pin(-17.1, -63.1), NOW),
      h.service.tryAttach(pin(-17.9, -63.9), NOW),
    ]);

    const results = [a.result, b.result].sort();
    expect(results).toEqual(['attached', 'location_conflict']);
    const winner = a.result === 'attached' ? pin(-17.1, -63.1) : pin(-17.9, -63.9);
    expect(h.tables.orders[0]).toMatchObject({
      delivery_latitude: winner.latitude,
      delivery_longitude: winner.longitude,
    });
    expect(h.state.updates).toBe(1);
    expect(h.delivery.quoteForOrder).toHaveBeenCalledTimes(1);
  });

  it('claim perdido en concurrencia con el MISMO pin: uno adjunta y el otro es already_attached (idempotente)', async () => {
    const h = setup();

    const [a, b] = await Promise.all([
      h.service.tryAttach(pin(), NOW),
      h.service.tryAttach(pin(), NOW),
    ]);

    expect([a.result, b.result].sort()).toEqual(['already_attached', 'attached']);
    expect(h.state.updates).toBe(1);
  });

  it('mismas coordenadas ya guardadas: already_attached, sin escribir de nuevo', async () => {
    const h = setup([order({ delivery_latitude: -17.78, delivery_longitude: -63.18 })]);

    const out = await h.service.tryAttach(pin(), NOW);

    expect(out).toMatchObject({ result: 'already_attached', orderId: 'order-1' });
    expect(h.state.updates).toBe(0);
  });

  it('coordenadas diferentes ya guardadas: location_conflict, NO se sobrescribe y no se cotiza', async () => {
    const h = setup([order({ delivery_latitude: -17.78, delivery_longitude: -63.18 })]);

    const out = await h.service.tryAttach(pin(-10, -60), NOW);

    expect(out).toEqual({ result: 'location_conflict', orderId: 'order-1' });
    expect(h.tables.orders[0]).toMatchObject({
      delivery_latitude: -17.78,
      delivery_longitude: -63.18,
    });
    expect(h.state.updates).toBe(0);
    expect(h.delivery.quoteForOrder).not.toHaveBeenCalled();
  });

  describe('sin pedido pendiente', () => {
    it('teléfono sin cliente', async () => {
      const h = setup([order()], []);
      await expect(h.service.tryAttach(pin(), NOW)).resolves.toEqual({ result: 'no_order' });
      expect(h.state.updates).toBe(0);
    });

    it('cliente sin pedido', async () => {
      const h = setup([]);
      await expect(h.service.tryAttach(pin(), NOW)).resolves.toEqual({ result: 'no_order' });
    });

    it.each([
      ['pedido de retiro', { delivery_type: 'pickup' }],
      ['pedido ya confirmado', { status: 'confirmed' }],
      ['pedido cancelado', { status: 'cancelled' }],
      ['pedido de otro cliente', { customer_id: 'cust-2' }],
    ])('%s no es candidato', async (_l, override) => {
      const h = setup([order(override)]);
      await expect(h.service.tryAttach(pin(), NOW)).resolves.toEqual({ result: 'no_order' });
      expect(h.state.updates).toBe(0);
      expect(h.delivery.quoteForOrder).not.toHaveBeenCalled();
    });

    it('teléfono vacío', async () => {
      const h = setup();
      await expect(h.service.tryAttach({ ...pin(), customerPhone: '' }, NOW)).resolves.toEqual({
        result: 'no_order',
      });
    });
  });

  describe(`ventana de ${LOOSE_PIN_WINDOW_HOURS} horas`, () => {
    it('un pedido de hace más de 6 horas NO recibe el pin', async () => {
      const h = setup([order({ created_at: hoursAgo(6.01) })]);

      await expect(h.service.tryAttach(pin(), NOW)).resolves.toEqual({ result: 'no_order' });
      expect(h.tables.orders[0].delivery_latitude).toBeNull();
      expect(h.delivery.quoteForOrder).not.toHaveBeenCalled();
    });

    it('un pedido dentro de la ventana sí', async () => {
      const h = setup([order({ created_at: hoursAgo(5.9) })]);
      await expect(h.service.tryAttach(pin(), NOW)).resolves.toMatchObject({ result: 'attached' });
    });

    it('con dos pedidos esperando, el pin va al MÁS RECIENTE', async () => {
      const h = setup([
        order({ id: 'viejo', created_at: hoursAgo(3) }),
        order({ id: 'nuevo', created_at: hoursAgo(1) }),
      ]);

      const out = await h.service.tryAttach(pin(), NOW);

      expect(out).toMatchObject({ result: 'attached', orderId: 'nuevo' });
      expect(h.tables.orders.find((o) => o.id === 'viejo')?.delivery_latitude).toBeNull();
    });
  });

  describe('quoteForOrder solo cuando corresponde', () => {
    it.each([
      ['cotización ya cerrada (quoted)', { delivery_quote_status: 'quoted' }],
      ['cotización manual pendiente (pending_manual)', { delivery_quote_status: 'pending_manual' }],
      ['sin cotización (null)', { delivery_quote_status: null }],
      ['pricing no dinámico', { delivery_pricing: null }],
    ])('%s: adjunta pero NO cotiza', async (_l, override) => {
      const h = setup([order(override)]);

      const out = await h.service.tryAttach(pin(), NOW);

      expect(out).toEqual({ result: 'attached', orderId: 'order-1', quoted: false });
      expect(h.delivery.quoteForOrder).not.toHaveBeenCalled();
    });

    it('cotización fallida previa (failed): sí cotiza', async () => {
      const h = setup([order({ delivery_quote_status: 'failed' })]);
      await h.service.tryAttach(pin(), NOW);
      expect(h.delivery.quoteForOrder).toHaveBeenCalledTimes(1);
    });

    it('si la cotización falla tras adjuntar, el error se propaga y el reintento no re-adjunta: ya adjunto + cotiza', async () => {
      const h = setup();
      h.delivery.quoteForOrder.mockRejectedValueOnce(new Error('mapbox down'));

      await expect(h.service.tryAttach(pin(), NOW)).rejects.toThrow('mapbox down');
      expect(h.tables.orders[0]).toMatchObject({ delivery_latitude: -17.78 });

      const retry = await h.service.tryAttach(pin(), NOW);

      expect(retry).toEqual({ result: 'already_attached', orderId: 'order-1', quoted: true });
      expect(h.state.updates).toBe(1);
      expect(h.delivery.quoteForOrder).toHaveBeenCalledTimes(2);
    });

    it('already_attached con la cotización ya cerrada no vuelve a cotizar', async () => {
      const h = setup([
        order({
          delivery_latitude: -17.78,
          delivery_longitude: -63.18,
          delivery_quote_status: 'quoted',
        }),
      ]);

      const out = await h.service.tryAttach(pin(), NOW);

      expect(out).toEqual({ result: 'already_attached', orderId: 'order-1', quoted: false });
      expect(h.delivery.quoteForOrder).not.toHaveBeenCalled();
    });
  });

  describe('errores reintentables', () => {
    it('claim perdido sin ganador visible y el pedido sigue esperando: LocationAttachRetryError', async () => {
      const h = setup();
      h.state.failNextClaim = true;

      await expect(h.service.tryAttach(pin(), NOW)).rejects.toBeInstanceOf(
        LocationAttachRetryError,
      );
      expect(h.delivery.quoteForOrder).not.toHaveBeenCalled();
    });

    it('claim perdido porque el pedido dejó de esperar ubicación: no_order (no hay nada que reintentar)', async () => {
      const h = setup();
      h.state.failNextClaim = true;
      h.tables.orders[0].status = 'cancelled';

      // El candidato se lee antes del cambio: se simula cambiando el estado justo
      // después de la lectura, en el momento del claim.
      const original = h.tables.orders[0];
      const service = h.service as unknown as { db: { updateTable: () => unknown } };
      const realUpdate = service.db.updateTable;
      original.status = 'awaiting_location';
      service.db.updateTable = () => {
        original.status = 'cancelled';
        return realUpdate();
      };

      await expect(h.service.tryAttach(pin(), NOW)).resolves.toEqual({ result: 'no_order' });
    });
  });
});

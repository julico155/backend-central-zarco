import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { Database } from '../database/types';
import { DeliveryDriversService, notHandledByPlatform } from './delivery-drivers.service';

const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

describe('repartidores propios — filtro de pedidos de la plataforma (solo con SMARKY_NOTIFY_OWN_DRIVERS=false)', () => {
  it('oculta lo que la plataforma atiende y deja pasar lo demás y lo abandonado', () => {
    const { sql, parameters } = db.selectFrom('orders').select('id').where(notHandledByPlatform).compile();
    expect(sql).toContain('"smarky_delivery_status" is null');
    expect(sql).toContain('"smarky_delivery_status" in ($1, $2)');
    expect(parameters).toEqual(['cancelled', 'failed']);
  });
});

describe('DeliveryDriversService.listAvailable según SMARKY_NOTIFY_OWN_DRIVERS', () => {
  function crear(delivery: unknown) {
    const consultas: string[] = [];
    const q: Record<string, jest.Mock> = {};
    for (const m of ['select', 'where', 'orderBy']) q[m] = jest.fn(() => q);
    q.$if = jest.fn((condicion: boolean, fn: (qb: unknown) => unknown) => {
      consultas.push(condicion ? 'filtro aplicado' : 'sin filtro');
      return condicion ? fn(q) : q;
    });
    q.execute = jest.fn().mockResolvedValue([]);
    const config = { get: (clave: string) => (clave === 'delivery' ? delivery : undefined) };
    const service = new DeliveryDriversService({ selectFrom: () => q } as never, {} as never, config as never);
    return { service, consultas };
  }

  it('transición (true) y proveedor interno (sin config): no se filtra nada', async () => {
    for (const delivery of [{ provider: 'smarky', smarky: { notifyOwnDrivers: true } }, { provider: 'internal', smarky: { notifyOwnDrivers: true } }, undefined]) {
      const { service, consultas } = crear(delivery);
      await service.listAvailable();
      expect(consultas).toEqual(['sin filtro']);
    }
  });

  it('solo plataforma (false): se aplica el filtro', async () => {
    const { service, consultas } = crear({ provider: 'smarky', smarky: { notifyOwnDrivers: false } });
    await service.listAvailable();
    expect(consultas).toEqual(['filtro aplicado']);
  });
});

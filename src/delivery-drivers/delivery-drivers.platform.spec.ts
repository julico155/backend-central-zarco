import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { Database } from '../database/types';
import { notHandledByPlatform } from './delivery-drivers.service';

const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

describe('repartidores propios — pedidos tomados por la plataforma de reparto', () => {
  it('el filtro oculta los pedidos que la plataforma tiene y deja pasar los demás', () => {
    const { sql, parameters } = db.selectFrom('orders').select('id').where(notHandledByPlatform).compile();
    expect(sql).toContain('"smarky_delivery_status" is null');
    expect(sql).toContain('"smarky_delivery_status" in ($1, $2)');
    expect(parameters).toEqual(['cancelled', 'failed']);
  });
});

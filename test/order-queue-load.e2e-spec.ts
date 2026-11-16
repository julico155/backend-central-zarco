import { Kysely } from 'kysely';
import { Database } from '../src/database/types';
import { OrderQueueService } from '../src/order-queue/order-queue.service';
import { createTestDb, describeIfDb } from './utils/test-db';

/**
 * La cola es para los clientes de WhatsApp: solo sus pedidos cuentan para llenar la cocina. Los del mostrador (pos)
 * ocupan cocina pero no le quitan lugar a la fila.
 *
 *   DATABASE_URL=... npm run migrate:up
 *   DATABASE_URL=... npm run test:e2e
 *
 * `summary()` usa su propia conexión (no una transacción), así que los pedidos se crean de verdad y se borran al final;
 * la prueba compara contra el valor de antes, para no depender de lo que ya hubiera en la base.
 */
describeIfDb('Cola de pedidos: qué cuenta como carga de cocina (integración)', () => {
  let db: Kysely<Database>;
  const tag = `QTEST-${Date.now()}`;

  beforeAll(() => {
    db = createTestDb();
  });

  afterAll(async () => {
    await db.deleteFrom('orders').where('order_number', 'like', `${tag}%`).execute();
    await db.destroy();
  });

  function queueService(): OrderQueueService {
    const settings = { getRow: async () => ({ queue_enabled: true, queue_capacity: 15, queue_release_batch: 5 }) };
    return new OrderQueueService(db, settings as never, undefined as never);
  }

  async function insertOrder(suffix: string, channel: 'pos' | 'whatsapp' | 'web', status: 'confirmed' | 'delivered' = 'confirmed') {
    await db
      .insertInto('orders')
      .values({
        order_number: `${tag}-${suffix}`,
        channel,
        customer_name: 'Prueba cola',
        delivery_type: 'pickup',
        payment_method: 'cash',
        status,
        subtotal_amount: '10.00',
        total_amount: '10.00',
        delivery_pricing: null,
      } as never)
      .execute();
  }

  it('un pedido del mostrador no cuenta; uno de WhatsApp sí', async () => {
    const service = queueService();
    const before = (await service.summary()).kitchenLoad;

    await insertOrder('pos', 'pos');
    expect((await service.summary()).kitchenLoad).toBe(before);

    await insertOrder('wa', 'whatsapp');
    expect((await service.summary()).kitchenLoad).toBe(before + 1);
  });

  it('un pedido de WhatsApp ya entregado deja de contar', async () => {
    const service = queueService();
    const before = (await service.summary()).kitchenLoad;

    await insertOrder('wa-entregado', 'whatsapp', 'delivered');
    expect((await service.summary()).kitchenLoad).toBe(before);
  });
});

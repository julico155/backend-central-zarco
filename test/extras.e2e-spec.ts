import { Kysely, sql, Transaction } from 'kysely';
import { Database } from '../src/database/types';
import { OrdersService } from '../src/orders/orders.service';
import { ExtrasService } from '../src/extras/extras.service';
import { createTestDb, describeIfDb } from './utils/test-db';

/**
 * Extras con precio (carne, queso, huevo) contra un Postgres real con las migraciones aplicadas:
 *   DATABASE_URL=... npm run migrate:up
 *   DATABASE_URL=... npm run test:e2e
 *
 * Cada caso corre dentro de una transacción que se revierte al final, así no deja datos.
 */
class Rollback extends Error {}

describeIfDb('Extras (integración)', () => {
  let db: Kysely<Database>;

  beforeAll(() => {
    db = createTestDb();
  });

  afterAll(async () => {
    await db.destroy();
  });

  /** Corre `body` en una transacción y la revierte siempre. */
  async function inRollback(body: (trx: Transaction<Database>) => Promise<void>): Promise<void> {
    try {
      await db.transaction().execute(async (trx) => {
        await body(trx);
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  }

  async function seed(trx: Transaction<Database>) {
    const category = await trx.insertInto('categories').values({ name: `Cat ${Math.random()}` }).returningAll().executeTakeFirstOrThrow();
    const product = (code: string, name: string, price: string) =>
      trx
        .insertInto('products')
        .values({ code: `${code}-${Math.random()}`, name, category_id: category.id, price })
        .returningAll()
        .executeTakeFirstOrThrow();
    const tranca = await product('TRP', 'Trancapecho', '18.00');
    const mixto = await product('MIX', 'Mixto', '20.00');

    const extra = async (name: string, price: string, appliesToAll: boolean, productIds: string[], isActive = true) => {
      const row = await trx
        .insertInto('extras')
        .values({ name, price, applies_to_all: appliesToAll, is_active: isActive })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (productIds.length > 0) {
        await trx
          .insertInto('extra_products')
          .values(productIds.map((productId) => ({ extra_id: row.id, product_id: productId })))
          .execute();
      }
      return row;
    };
    const carneTranca = await extra('Carne', '10.00', false, [tranca.id]);
    const carneMixto = await extra('Carne', '12.50', false, [mixto.id]);
    const queso = await extra('Queso', '3.00', true, []);
    const huevoApagado = await extra('Huevo', '2.00', true, [], false);
    return { tranca, mixto, carneTranca, carneMixto, queso, huevoApagado };
  }

  function ordersService(): OrdersService {
    // createOrderInTransaction solo usa la base: el resto de las dependencias no entra en juego.
    const stub = undefined as never;
    return new OrdersService(db, stub, stub, stub, stub, stub, stub, stub, stub);
  }

  const base = {
    customerId: null,
    channel: 'pos' as const,
    customerName: 'Cliente',
    deliveryType: 'pickup' as const,
    paymentMethod: 'cash' as const,
    notes: null,
    promotions: [],
  };

  it('suma los extras al subtotal de la línea y los guarda como snapshot', async () => {
    await inRollback(async (trx) => {
      const s = await seed(trx);
      const order = await ordersService().createOrderInTransaction(trx, {
        ...base,
        items: [
          { productId: s.tranca.id, quantity: 2 },
          {
            productId: s.tranca.id,
            quantity: 1,
            extras: [
              { extraId: s.carneTranca.id, quantity: 2 },
              { extraId: s.queso.id, quantity: 1 },
            ],
          },
        ],
      });

      // 2 × 18 + 1 × (18 + 2×10 + 3) = 36 + 41
      expect(order.subtotalAmount).toBe(77);
      expect(order.totalAmount).toBe(77);

      const plain = order.items.find((i) => i.extras.length === 0)!;
      expect(plain.subtotal).toBe(36);

      const extended = order.items.find((i) => i.extras.length > 0)!;
      expect(extended.unitPriceSnapshot).toBe(18); // el producto solo
      expect(extended.subtotal).toBe(41); // con extras
      expect(extended.extras).toEqual([
        { extraId: s.carneTranca.id, name: 'Carne', unitPrice: 10, quantity: 2 },
        { extraId: s.queso.id, name: 'Queso', unitPrice: 3, quantity: 1 },
      ]);

      // Lo guardado en la base (jsonb) es lo mismo que lo devuelto.
      const stored = await trx.selectFrom('order_items').select(['subtotal', 'extras']).where('order_id', '=', order.id).execute();
      expect(stored.map((r) => Number(r.subtotal)).sort()).toEqual([36, 41]);
      expect(stored.find((r) => r.extras.length > 0)!.extras).toEqual(extended.extras);
    });
  });

  it('cantidad × (producto + extras): 3 unidades con doble carne', async () => {
    await inRollback(async (trx) => {
      const s = await seed(trx);
      const order = await ordersService().createOrderInTransaction(trx, {
        ...base,
        items: [{ productId: s.mixto.id, quantity: 3, extras: [{ extraId: s.carneMixto.id, quantity: 2 }] }],
      });
      // 3 × (20 + 2 × 12.50) = 135
      expect(order.subtotalAmount).toBe(135);
    });
  });

  it('el snapshot no cambia si después sube el precio del extra', async () => {
    await inRollback(async (trx) => {
      const s = await seed(trx);
      const order = await ordersService().createOrderInTransaction(trx, {
        ...base,
        items: [{ productId: s.tranca.id, quantity: 1, extras: [{ extraId: s.carneTranca.id, quantity: 1 }] }],
      });
      await trx.updateTable('extras').set({ price: '99.00' }).where('id', '=', s.carneTranca.id).execute();

      const stored = await trx.selectFrom('order_items').select(['subtotal', 'extras']).where('order_id', '=', order.id).executeTakeFirstOrThrow();
      expect(Number(stored.subtotal)).toBe(28);
      expect(stored.extras[0].unitPrice).toBe(10);
    });
  });

  it('un pedido sin extras queda exactamente como antes', async () => {
    await inRollback(async (trx) => {
      const s = await seed(trx);
      const order = await ordersService().createOrderInTransaction(trx, {
        ...base,
        items: [{ productId: s.tranca.id, quantity: 3 }],
      });
      expect(order.subtotalAmount).toBe(54);
      expect(order.items[0].extras).toEqual([]);
    });
  });

  it('compatibilidad: sin la migración aplicada, un pedido sin extras se sigue creando', async () => {
    await inRollback(async (trx) => {
      const s = await seed(trx);
      // Simula el backend nuevo corriendo antes de la migración: la columna todavía no existe (se revierte con la transacción).
      await sql`alter table order_items drop column extras`.execute(trx);

      const order = await ordersService().createOrderInTransaction(trx, {
        ...base,
        items: [{ productId: s.tranca.id, quantity: 2 }],
      });
      expect(order.subtotalAmount).toBe(36);
      expect(order.items[0].extras).toEqual([]);
    });
  });

  it('rechaza la carne de otro plato, un extra apagado y uno inexistente', async () => {
    await inRollback(async (trx) => {
      const s = await seed(trx);
      const service = ordersService();
      const codeOf = async (extraId: string) => {
        try {
          await service.createOrderInTransaction(trx, {
            ...base,
            items: [{ productId: s.tranca.id, quantity: 1, extras: [{ extraId, quantity: 1 }] }],
          });
          return 'creado';
        } catch (error) {
          return (error as { code?: string }).code ?? 'otro';
        }
      };

      expect(await codeOf(s.carneMixto.id)).toBe('extra_not_for_product');
      expect(await codeOf(s.huevoApagado.id)).toBe('extra_unavailable');
      expect(await codeOf('00000000-0000-4000-8000-000000000000')).toBe('unknown_extra');
    });
  });

  it('dos líneas del mismo producto con distintos extras son válidas; con los mismos extras, duplicadas', async () => {
    await inRollback(async (trx) => {
      const s = await seed(trx);
      const service = ordersService();
      const ok = await service.createOrderInTransaction(trx, {
        ...base,
        items: [
          { productId: s.tranca.id, quantity: 1 },
          { productId: s.tranca.id, quantity: 1, extras: [{ extraId: s.queso.id, quantity: 1 }] },
        ],
      });
      expect(ok.items).toHaveLength(2);

      const duplicated = await (async () => {
        try {
          await service.createOrderInTransaction(trx, {
            ...base,
            items: [
              { productId: s.tranca.id, quantity: 1, extras: [{ extraId: s.queso.id, quantity: 1 }] },
              { productId: s.tranca.id, quantity: 2, extras: [{ extraId: s.queso.id, quantity: 1 }] },
            ],
          });
          return 'creado';
        } catch (error) {
          return (error as { code?: string }).code ?? 'otro';
        }
      })();
      expect(duplicated).toBe('validation_error');
    });
  });

  describe('ExtrasService', () => {
    /** ExtrasService abre su propia transacción, así que acá se trabaja con datos reales y se limpian al terminar. */
    async function withRealData(body: (ids: { tranca: string; mixto: string }, service: ExtrasService) => Promise<void>) {
      const category = await db.insertInto('categories').values({ name: `Test extras ${Math.random()}` }).returningAll().executeTakeFirstOrThrow();
      const make = (name: string) =>
        db.insertInto('products').values({ code: `T-${Math.random()}`, name, category_id: category.id, price: '10.00' }).returningAll().executeTakeFirstOrThrow();
      const tranca = await make('Tranca test');
      const mixto = await make('Mixto test');
      const service = new ExtrasService(db);
      const createdExtraNames = ['Carne test'];
      try {
        await body({ tranca: tranca.id, mixto: mixto.id }, service);
      } finally {
        await db.deleteFrom('extras').where('name', 'in', createdExtraNames).execute();
        await db.deleteFrom('products').where('category_id', '=', category.id).execute();
        await db.deleteFrom('categories').where('id', '=', category.id).execute();
      }
    }

    it('crea, lista por plato, edita y desactiva', async () => {
      await withRealData(async (ids, service) => {
        const created = await service.create({ name: ' Carne test ', price: 11, appliesToAll: false, productIds: [ids.tranca] });
        expect(created).toMatchObject({ name: 'Carne test', price: 11, appliesToAll: false, productIds: [ids.tranca], isActive: true });

        const toAll = await service.update(created.id, { appliesToAll: true });
        expect(toAll.appliesToAll).toBe(true);
        expect(toAll.productIds).toEqual([]);

        const back = await service.update(created.id, { appliesToAll: false, productIds: [ids.mixto], price: 12 });
        expect(back).toMatchObject({ appliesToAll: false, productIds: [ids.mixto], price: 12 });

        await service.update(created.id, { isActive: false });
        expect((await service.findMany(false)).some((e) => e.id === created.id)).toBe(false);
        expect((await service.findMany(true)).some((e) => e.id === created.id)).toBe(true);
      });
    });

    it('"solo algunos platos" sin elegir ninguno es un error claro', async () => {
      const service = new ExtrasService(db);
      await expect(service.create({ name: 'Carne test', price: 5, appliesToAll: false, productIds: [] })).rejects.toMatchObject({
        code: 'validation_error',
      });
    });

    it('un producto inexistente da un error claro y no deja el extra a medias', async () => {
      const service = new ExtrasService(db);
      await expect(
        service.create({ name: 'Carne test', price: 5, appliesToAll: false, productIds: ['00000000-0000-4000-8000-000000000000'] }),
      ).rejects.toMatchObject({ code: 'validation_error' });
      expect((await service.findMany(true)).some((e) => e.name === 'Carne test')).toBe(false);
    });
  });
});

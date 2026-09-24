import 'reflect-metadata';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { AGENT_KYSELY, AgentDatabaseModule, createAgentKysely } from './agent-database.module';
import { DatabaseModule, KYSELY } from './database.module';
import { AgentRepository } from '../sarco-agent/memory/agent.repository';
import { MenuSessionRepository } from '../sarco-menu/menu-session.repository';
import { MenuSendDeliveryRepository } from '../sarco-menu/menu-send-delivery.repository';
import { MenuOrderService } from '../sarco-menu/menu-order.service';
import { WebhookInboxService } from '../webhook-inbox/webhook-inbox.service';
import { OrdersService } from '../orders/orders.service';
import { CustomersService } from '../customers/customers.service';
import { ProductsService } from '../products/products.service';
import { CategoriesService } from '../categories/categories.service';
import { PromotionsService } from '../promotions/promotions.service';
import { PaymentProofsService } from '../payment-proofs/payment-proofs.service';
import { PaymentAttemptsService } from '../payment-attempts/payment-attempts.service';
import { NotificationsOutService } from '../notifications-out/notifications-out.service';
import { DeliveryNoticeService } from '../delivery-notice/delivery-notice.service';
import { DeliveryService } from '../delivery/delivery.service';
import { PaymentProofAnalysisService } from '../sarco-payment-proof/payment-proof-analysis.service';
import { SubmitMenuOrderDto } from '../sarco-menu/dto/submit-menu-order.dto';

/** Token inyectado (`@Inject(X)`) en cada parámetro del constructor que lo declara. */
function injectedTokens(cls: new (...args: never[]) => unknown): unknown[] {
  const meta = (Reflect.getMetadata('self:paramtypes', cls) ?? []) as {
    index: number;
    param: unknown;
  }[];
  return meta.map((m) => m.param);
}

describe('cada servicio usa SU base de datos', () => {
  it.each<[string, new (...args: never[]) => unknown]>([
    ['WebhookInboxService', WebhookInboxService],
    ['AgentRepository', AgentRepository],
    ['MenuSessionRepository (menu_sessions)', MenuSessionRepository],
    ['MenuSendDeliveryRepository (menu_send_deliveries)', MenuSendDeliveryRepository],
  ])('%s usa AGENT_KYSELY (y no KYSELY)', (_name, cls) => {
    const tokens = injectedTokens(cls);
    expect(tokens).toContain(AGENT_KYSELY);
    expect(tokens).not.toContain(KYSELY);
  });

  it.each<[string, new (...args: never[]) => unknown]>([
    ['OrdersService', OrdersService],
    ['CustomersService', CustomersService],
    ['ProductsService', ProductsService],
    ['CategoriesService', CategoriesService],
    ['PromotionsService', PromotionsService],
    ['PaymentProofsService', PaymentProofsService],
    ['PaymentProofAnalysisService', PaymentProofAnalysisService],
    ['PaymentAttemptsService', PaymentAttemptsService],
    ['NotificationsOutService', NotificationsOutService],
    ['DeliveryNoticeService', DeliveryNoticeService],
    ['DeliveryService', DeliveryService],
    // Lee `products` (Central) para traducir el carrito; la sesión la lee del repositorio Agent.
    ['MenuOrderService', MenuOrderService],
  ])('%s usa KYSELY Central (y no AGENT_KYSELY)', (_name, cls) => {
    const tokens = injectedTokens(cls);
    expect(tokens).toContain(KYSELY);
    expect(tokens).not.toContain(AGENT_KYSELY);
  });
});

/** Kysely sobre un Postgres falso que registra el SQL; `responder` decide las filas. */
function recordingDb<T>(responder: (sqlText: string) => Record<string, unknown>[] = () => []) {
  const statements: string[] = [];
  const client = {
    query: async (sqlText: string) => {
      statements.push(sqlText.replace(/\s+/g, ' ').trim().toLowerCase());
      const rows = responder(sqlText.toLowerCase());
      return { command: 'SELECT', rowCount: rows.length, rows };
    },
    release: () => undefined,
  };
  const db = new Kysely<T>({
    dialect: new PostgresDialect({
      pool: { connect: async () => client, end: async () => undefined } as never,
    }),
  });
  return { db, statements };
}

/** DB que rechaza cualquier consulta: demuestra que un servicio NO la toca. */
function forbiddenDb<T>(label: string) {
  const { db } = recordingDb<T>(() => {
    throw new Error(`${label}: no debía consultarse`);
  });
  return db;
}

describe('las consultas de agente/menú van SOLO a la DB Agente', () => {
  it('WebhookInboxService.accept escribe webhook_events en Agent', async () => {
    const agent = recordingDb(() => [{ id: 'evt-1' }]);
    const service = new WebhookInboxService(agent.db as never, {} as never);

    await service.accept({
      eventId: 'e1',
      eventName: 'whatsapp.message.received',
      messageId: 'm1',
      payload: {},
    } as never);

    expect(agent.statements.some((s) => s.includes('into "webhook_events"'))).toBe(true);
  });

  it('AgentRepository.upsertConversation escribe agent_conversations en Agent', async () => {
    const agent = recordingDb(() => [{ id: 'c1', state: 'active' }]);
    const repo = new AgentRepository(agent.db as never);

    await repo.upsertConversation({
      customerPhone: '59170000000',
      providerConversationId: null,
      providerPhoneNumberId: null,
    } as never);

    expect(agent.statements[0]).toContain('"agent_conversations"');
  });

  it('MenuSessionRepository.findByHash lee menu_sessions en Agent', async () => {
    const agent = recordingDb();
    const repo = new MenuSessionRepository(agent.db as never);

    await expect(repo.findByHash('a'.repeat(64))).resolves.toBeNull();

    expect(agent.statements[0]).toContain('from "menu_sessions"');
  });

  it('MenuSendDeliveryRepository.claim escribe menu_send_deliveries en Agent', async () => {
    const agent = recordingDb(() => [{ id: 'd1' }]);
    const repo = new MenuSendDeliveryRepository(agent.db as never);

    await expect(repo.claim('wamid.1', '59170000000', 'explicit_request')).resolves.toEqual({
      claimed: true,
      id: 'd1',
    });

    expect(agent.statements[0]).toContain('into "menu_send_deliveries"');
  });
});

describe('menu_session en Agent → OrdersService en Central, sin duplicar pedido', () => {
  const sessionRow = {
    id: 'session-1',
    source_message_id: 'wamid.1',
    token_hash: 'a'.repeat(64),
    customer_phone: '59170000000',
    phone_number_id: 'phone-1',
    expires_at: new Date(Date.now() + 3_600_000),
    replaces_order_id: null,
  };

  function cart(items = [{ code: 'lomito', quantity: 1 }]) {
    const dto = new SubmitMenuOrderDto();
    dto.session_token = 'token-abc';
    dto.customer_name = 'Juan';
    dto.delivery_type = 'pickup';
    dto.payment_method = 'qr';
    dto.items = items;
    return dto;
  }

  function setup() {
    const agent = recordingDb((s) => (s.includes('"menu_sessions"') ? [sessionRow] : []));
    const central = recordingDb((s) =>
      s.includes('"products"') ? [{ id: 'prod-1', code: 'lomito' }] : [],
    );

    // OrdersService de Central con la idempotencia real de `Idempotency-Key`:
    // misma clave + mismo contenido → mismo pedido; mismo contenido distinto → 409.
    const store = new Map<string, { hash: string; order: { id: string } }>();
    const created: unknown[] = [];
    const orders = {
      create: jest.fn(async (dto: unknown, key: string) => {
        const hash = JSON.stringify(dto);
        const prior = store.get(key);
        if (prior) {
          if (prior.hash !== hash) throw new Error('idempotency_key_reused');
          return { httpStatus: 200, body: prior.order };
        }
        const order = { id: `order-${created.length + 1}` };
        created.push(order);
        store.set(key, { hash, order });
        return { httpStatus: 201, body: order };
      }),
    };
    const customers = { findOrCreate: jest.fn().mockResolvedValue({ id: 'customer-1' }) };
    const service = new MenuOrderService(
      central.db as never,
      new MenuSessionRepository(agent.db as never),
      customers as never,
      orders as never,
    );
    return { service, agent, central, orders, created };
  }

  it('la sesión se lee de Agent, los productos de Central y el pedido lo crea OrdersService', async () => {
    const h = setup();

    const outcome = await h.service.submit(cart());

    expect(outcome).toMatchObject({ httpStatus: 201, body: { id: 'order-1' } });
    expect(h.agent.statements.every((s) => s.includes('"menu_sessions"'))).toBe(true);
    expect(h.central.statements.every((s) => s.includes('"products"'))).toBe(true);
    expect(h.orders.create.mock.calls[0][1]).toBe('session-1');
  });

  it('un retry (mismo carrito, misma sesión) NO duplica el pedido y devuelve el mismo', async () => {
    const h = setup();

    const first = await h.service.submit(cart());
    const retry = await h.service.submit(cart());

    expect(h.created).toHaveLength(1);
    expect(retry).toMatchObject({ body: first.body });
  });

  it('otro carrito con la MISMA sesión es rechazado, tampoco crea un segundo pedido', async () => {
    const h = setup();

    await h.service.submit(cart());
    await expect(h.service.submit(cart([{ code: 'lomito', quantity: 5 }]))).rejects.toThrow(
      'idempotency_key_reused',
    );

    expect(h.created).toHaveLength(1);
  });

  it('si la DB Agente cae, el pedido ni se intenta (no hay estado a medias en Central)', async () => {
    const orders = { create: jest.fn() };
    const service = new MenuOrderService(
      forbiddenDb('central') as never,
      new MenuSessionRepository(forbiddenDb('agent') as never),
      { findOrCreate: jest.fn() } as never,
      orders as never,
    );

    await expect(service.submit(cart())).rejects.toThrow('agent: no debía consultarse');
    expect(orders.create).not.toHaveBeenCalled();
  });
});

describe('conexiones: dos pools independientes que se cierran al apagar', () => {
  it('createAgentKysely sin URL no conecta a ninguna parte (ni a DATABASE_URL ni a localhost)', async () => {
    const db = createAgentKysely('');

    await expect(sql`select 1`.execute(db)).rejects.toThrow(
      'AGENT_DATABASE_URL no está configurada',
    );
    await db.destroy();
  });

  describe('con pg simulado', () => {
    const pools: { connectionString: string; ended: boolean }[] = [];

    beforeEach(() => {
      pools.length = 0;
      jest.resetModules();
      jest.doMock('pg', () => ({
        Pool: jest.fn().mockImplementation((options: { connectionString: string }) => {
          const pool = { connectionString: options.connectionString, ended: false };
          pools.push(pool);
          return {
            connect: async () => ({
              query: async () => ({ command: 'SELECT', rowCount: 1, rows: [{ ok: 1 }] }),
              release: () => undefined,
            }),
            end: async () => {
              pool.ended = true;
            },
          };
        }),
      }));
    });

    afterEach(() => {
      jest.dontMock('pg');
      jest.resetModules();
    });

    it('KYSELY y AGENT_KYSELY usan cadenas distintas y ambos pools se cierran al apagar Nest', async () => {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { DatabaseModule: Central, KYSELY: CENTRAL } = require('./database.module');
      const {
        AgentDatabaseModule: Agent,
        AGENT_KYSELY: AGENT,
      } = require('./agent-database.module');
      const { ConfigModule: Config } = require('@nestjs/config');
      const { Test: T } = require('@nestjs/testing');
      const { sql: sqlCopy } = require('kysely');
      /* eslint-enable @typescript-eslint/no-require-imports */

      const moduleRef = await T.createTestingModule({
        imports: [
          Config.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            load: [
              () => ({
                databaseUrl: 'postgres://central-host/central',
                agentDatabaseUrl: 'postgres://agent-host/agent',
              }),
            ],
          }),
          Central,
          Agent,
        ],
      }).compile();

      const central = moduleRef.get(CENTRAL);
      const agent = moduleRef.get(AGENT);
      expect(central).not.toBe(agent);

      await sqlCopy`select 1`.execute(central);
      await sqlCopy`select 1`.execute(agent);
      expect(pools.map((p) => p.connectionString).sort()).toEqual([
        'postgres://agent-host/agent',
        'postgres://central-host/central',
      ]);

      await moduleRef.close();
      expect(pools.every((p) => p.ended)).toBe(true);
    });
  });

  it('ambos módulos son globales (cualquier servicio puede inyectar su conexión)', () => {
    expect(Reflect.getMetadata('__module:global__', DatabaseModule)).toBe(true);
    expect(Reflect.getMetadata('__module:global__', AgentDatabaseModule)).toBe(true);
  });
});

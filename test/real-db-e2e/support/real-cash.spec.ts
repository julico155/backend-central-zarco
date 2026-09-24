import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresDialect,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from 'kysely';
import type { AgentDatabase } from '../../../src/database/agent-types';
import type { Database } from '../../../src/database/types';
import {
  CENTRAL_WRITE_ALLOWLIST,
  auditWrites,
  countCounterIncrements,
  isCounterIncrement,
} from './audit';
import { cleanupFromManifest } from './cleanup';
import { Manifest } from './manifest';
import { readE2EOptions } from './options';
import {
  evaluatePreflight,
  runPreflight,
  type AgentFacts,
  type CentralFacts,
  type Queryable,
} from './preflight';
import { takeSnapshot } from './snapshot';

const goodEnv = {
  ALLOW_REAL_DB_E2E: 'true',
  E2E_PHONE: '59170001234',
  DATABASE_URL: 'postgres://u:p@central.example/db',
  AGENT_DATABASE_URL: 'postgres://u:p@agent.example/db',
};

const cleanCentral: CentralFacts = {
  foreignSessions: [],
  openCashSessions: 0,
  openCashDetail: [],
  phoneCustomers: 0,
  leftovers: { products: 0, categories: 0, cashSessions: 0 },
  settingsRows: 1,
};
const cleanAgent: AgentFacts = {
  foreignSessions: [],
  phoneConversations: 0,
  phoneMenuSessions: 0,
  phoneMenuDeliveries: 0,
  leftoverWebhookEvents: 0,
};

const openCash = (over: Partial<CentralFacts['openCashDetail'][number]> = {}): CentralFacts => ({
  ...cleanCentral,
  openCashSessions: 1,
  openCashDetail: [{ id: 'caja-real', nextOrderNumber: 41, isLatestByOpenedAt: true, ...over }],
});

describe('ALLOW_OPEN_REAL_CASH_REGISTER — preflight', () => {
  it('por defecto (ausente o distinta de "true") una caja real abierta sigue abortando', () => {
    expect(readE2EOptions(goodEnv).allowOpenRealCashRegister).toBe(false);
    expect(
      readE2EOptions({ ...goodEnv, ALLOW_OPEN_REAL_CASH_REGISTER: '1' }).allowOpenRealCashRegister,
    ).toBe(false);
    expect(
      readE2EOptions({ ...goodEnv, ALLOW_OPEN_REAL_CASH_REGISTER: 'true' })
        .allowOpenRealCashRegister,
    ).toBe(true);
    expect(evaluatePreflight(openCash(), cleanAgent).join('\n')).toContain('caja REAL abierta');
    expect(
      evaluatePreflight(openCash(), cleanAgent, { allowOpenRealCashRegister: false }).join('\n'),
    ).toContain('caja REAL abierta');
  });

  it('con la variable: EXACTAMENTE una caja abierta y la más reciente es aceptable', () => {
    expect(evaluatePreflight(openCash(), cleanAgent, { allowOpenRealCashRegister: true })).toEqual(
      [],
    );
  });

  it('con la variable pero SIN caja abierta aborta (se exige exactamente una)', () => {
    const problems = evaluatePreflight(cleanCentral, cleanAgent, {
      allowOpenRealCashRegister: true,
    });
    expect(problems.join('\n')).toContain('EXACTAMENTE una caja abierta (hay 0)');
  });

  it('con la variable pero más de una caja abierta aborta', () => {
    const many: CentralFacts = { ...openCash(), openCashSessions: 2 };
    expect(
      evaluatePreflight(many, cleanAgent, { allowOpenRealCashRegister: true }).join('\n'),
    ).toContain('hay 2');
  });

  it('con la variable, si la caja abierta NO es la más reciente aborta (el correlativo iría a otra caja)', () => {
    const problems = evaluatePreflight(openCash({ isLatestByOpenedAt: false }), cleanAgent, {
      allowOpenRealCashRegister: true,
    });
    expect(problems.join('\n')).toContain('no es la sesión más reciente');
  });

  it('el resto de las guardas siguen activas con la variable', () => {
    const problems = evaluatePreflight(
      { ...openCash(), phoneCustomers: 1, foreignSessions: [{ app: 'railway', n: 2 }] },
      { ...cleanAgent, phoneConversations: 1 },
      { allowOpenRealCashRegister: true },
    ).join('\n');
    expect(problems).toContain('customers');
    expect(problems).toContain('agent_conversations');
    expect(problems).toContain('conexiones ajenas');
  });

  it('runPreflight guarda el id de la caja y su next_order_number anterior (solo si está permitido)', async () => {
    const client = (rows: Record<string, unknown[]>): Queryable => ({
      async query(text) {
        const key = Object.keys(rows).find((k) => text.includes(k));
        return { rows: (key ? rows[key] : [{ n: 0 }]) as Record<string, unknown>[] };
      },
    });
    const central = client({
      pg_stat_activity: [],
      is_latest: [{ id: 'caja-real', next_order_number: 41, is_latest: true }],
      "count(*)::int as n from cash_register_sessions where status = 'open'": [{ n: 1 }],
      operational_settings: [{ n: 1 }],
    });
    const agent = client({ pg_stat_activity: [] });
    const opts = { phone: '59170001234', ignoredApplicationNames: [] };

    const allowed = await runPreflight(central, agent, {
      ...opts,
      allowOpenRealCashRegister: true,
    });
    expect(allowed.realCash).toEqual({ id: 'caja-real', nextOrderNumberBefore: 41 });

    await expect(runPreflight(central, agent, opts)).rejects.toThrow('caja REAL abierta');
  });
});

const REAL = '11111111-1111-1111-1111-111111111111';
const write = (sql: string, ...parameters: unknown[]) => ({ sql, parameters });
const INCREMENT =
  'update "cash_register_sessions" set "next_order_number" = next_order_number + 1 where "id" = $1 returning "next_order_number"';

describe('caja real — auditoría', () => {
  it('acepta ÚNICAMENTE el avance de next_order_number sobre el id exacto de la caja real', () => {
    expect(
      auditWrites(
        [write(INCREMENT, REAL)],
        CENTRAL_WRITE_ALLOWLIST,
        new Set(),
        '59170001234',
        REAL,
      ),
    ).toEqual([]);
    expect(countCounterIncrements([write(INCREMENT, REAL), write(INCREMENT, REAL)], REAL)).toBe(2);
    expect(
      countCounterIncrements([write(INCREMENT, '22222222-2222-2222-2222-222222222222')], REAL),
    ).toBe(0);
  });

  it.each([
    ['otro id', write(INCREMENT, '22222222-2222-2222-2222-222222222222')],
    [
      'otra columna (status)',
      write('update "cash_register_sessions" set "status" = $1 where "id" = $2', 'closed', REAL),
    ],
    [
      'cambio de opened_by',
      write('update "cash_register_sessions" set "opened_by" = $1 where "id" = $2', 'x', REAL),
    ],
    ['más de un parámetro', write(INCREMENT, REAL, 'extra')],
    [
      'sin where por id',
      write('update "cash_register_sessions" set "next_order_number" = next_order_number + 1'),
    ],
    ['DELETE de la caja', write('delete from "cash_register_sessions" where "id" = $1', REAL)],
    [
      'INSERT de otra caja',
      write('insert into "cash_register_sessions" ("opened_by") values ($1)', 'x'),
    ],
  ])('con caja real, %s es una violación', (_label, w) => {
    const violations = auditWrites(
      [w],
      CENTRAL_WRITE_ALLOWLIST,
      new Set([REAL]),
      '59170001234',
      REAL,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('cash_register_sessions');
  });

  it('sin caja real (caja propia) todo sigue acotado por el manifest', () => {
    expect(
      auditWrites(
        [write(INCREMENT, 'e2e-caja')],
        CENTRAL_WRITE_ALLOWLIST,
        new Set(['e2e-caja']),
        '59170001234',
      ),
    ).toEqual([]);
    expect(
      auditWrites(
        [write(INCREMENT, REAL)],
        CENTRAL_WRITE_ALLOWLIST,
        new Set(['e2e-caja']),
        '59170001234',
      ),
    ).toHaveLength(1);
  });
});

describe('caja real — snapshot y cleanup', () => {
  it('takeSnapshot enmascara SOLO el correlativo de la caja real, con el id como parámetro', async () => {
    const seen: { sql: string; params?: unknown[] }[] = [];
    const client = {
      async query(sql: string, params?: unknown[]) {
        seen.push({ sql, params });
        if (sql.includes('information_schema')) {
          return { rows: [{ table_name: 'cash_register_sessions' }, { table_name: 'orders' }] };
        }
        return { rows: [{ n: 4, h: 'abc' }] };
      },
    };

    await takeSnapshot(client, { realCashSessionId: REAL });

    const cash = seen.find((q) => q.sql.includes('"cash_register_sessions" t'));
    expect(cash?.sql).toContain("- 'next_order_number'");
    expect(cash?.params).toEqual([REAL]);
    expect(cash?.sql).not.toContain(REAL);
    expect(seen.find((q) => q.sql.includes('"orders" t'))?.sql).not.toContain('next_order_number');

    seen.length = 0;
    await takeSnapshot(client);
    expect(seen.find((q) => q.sql.includes('"cash_register_sessions" t'))?.sql).not.toContain(
      'next_order_number',
    );
  });

  it('el manifest guarda la caja real solo como información y nunca en las listas de borrado', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'e2e-cash-')), 'manifest.json');
    const manifest = Manifest.create(path, 'r', '59170001234');
    manifest.setRealCashSession({ id: REAL, nextOrderNumberBefore: 41 });

    expect(Manifest.load(path).data.realCashSession).toEqual({
      id: REAL,
      nextOrderNumberBefore: 41,
    });
    expect(manifest.ids('central', 'cash_register_sessions')).toEqual([]);
  });

  it('el cleanup no toca ninguna caja aunque el manifest tenga una caja real (ni cierra, ni borra, ni restaura)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'e2e-cash-')), 'manifest.json');
    const manifest = Manifest.create(path, 'r', '59170001234');
    manifest.setRealCashSession({ id: REAL, nextOrderNumberBefore: 41 });
    manifest.addCentral('orders', 'order-1');
    manifest.addCentral('customers', 'cust-1');

    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql.replace(/\s+/g, ' '));
        return { command: 'DELETE', rowCount: 1, rows: [] };
      },
      release: () => undefined,
    };
    const pool = { connect: async () => client, end: async () => undefined } as never;
    const central = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const agent = new Kysely<AgentDatabase>({ dialect: new PostgresDialect({ pool }) });

    await cleanupFromManifest(central, agent, manifest);

    const all = statements.join('\n');
    expect(all).not.toMatch(/cash_register_sessions/);
    expect(all).not.toContain(REAL);
    expect(all).not.toMatch(/^update/im);
  });
});

describe('caja real — la regla de auditoría coincide con el SQL REAL de orders.service', () => {
  it('el UPDATE que compila Kysely para assignOrderNumber es exactamente lo que la auditoría permite', () => {
    const db = new Kysely<Database>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (d) => new PostgresIntrospector(d),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    // Misma sentencia que OrdersService.assignOrderNumber (orders.service.ts).
    const compiled = db
      .updateTable('cash_register_sessions')
      .set({ next_order_number: sql`next_order_number + 1` })
      .where('id', '=', REAL)
      .returning('next_order_number')
      .compile();

    expect(isCounterIncrement({ sql: compiled.sql, parameters: compiled.parameters }, REAL)).toBe(
      true,
    );
  });
});

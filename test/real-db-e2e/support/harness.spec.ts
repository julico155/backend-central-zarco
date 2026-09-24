import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { Kysely, PostgresDialect } from 'kysely';
import type { Database } from '../../../src/database/types';
import type { AgentDatabase } from '../../../src/database/agent-types';
import { verifyKapsoSignature } from '../../../src/kapso/kapso-signature';
import { buildNormalizedEvents, parseKapsoEnvelopes } from '../../../src/kapso/kapso-normalizer';
import { AGENT_WRITE_ALLOWLIST, CENTRAL_WRITE_ALLOWLIST, WriteAudit, auditWrites } from './audit';
import { CleanupSafetyError, cleanupFromManifest } from './cleanup';
import {
  FAKE_KAPSO_BASE,
  FAKE_TELEGRAM_BASE,
  FakeBaneco,
  FakeExternals,
  OPENAI_URL,
  UnexpectedExternalRequestError,
} from './fake-externals';
import { inboundLocation, inboundText } from './kapso-payloads';
import { Manifest } from './manifest';
import { diffSnapshots, takeSnapshot } from './snapshot';

/** Referencias reales, capturadas al cargar el módulo (antes de cualquier install()). */
const ORIGINAL = { httpRequest: http.request, httpsRequest: https.request };

const tmp = () => join(mkdtempSync(join(tmpdir(), 'e2e-manifest-')), 'manifest.json');

describe('FakeExternals — nada real sale', () => {
  let ext: FakeExternals;
  beforeEach(() => {
    ext = new FakeExternals('tok');
    ext.install();
  });
  afterEach(() => ext.restore());

  it('Kapso: /messages devuelve un wamid, /media un id, y todo queda registrado', async () => {
    const msg = await fetch(`${FAKE_KAPSO_BASE}/phone-1/messages`, {
      method: 'POST',
      body: JSON.stringify({ type: 'text', to: '59170001234', text: { body: 'hola' } }),
    });
    expect(await msg.json()).toEqual({ messages: [{ id: 'wamid.e2e.out.1' }] });
    const media = await fetch(`${FAKE_KAPSO_BASE}/phone-1/media`, {
      method: 'POST',
      body: new FormData(),
    });
    expect(await media.json()).toEqual({ id: 'e2e-media-1' });
    expect(ext.kapsoMessages()).toEqual([
      { type: 'text', to: '59170001234', text: { body: 'hola' } },
    ]);
    expect(ext.violations).toEqual([]);
  });

  it('Telegram: solo con el token configurado; devuelve message_id', async () => {
    const ok = await fetch(`${FAKE_TELEGRAM_BASE}/bottok/sendMessage`, {
      method: 'POST',
      body: JSON.stringify({ chat_id: '-1', text: 'aviso' }),
    });
    expect(await ok.json()).toEqual({ ok: true, result: { message_id: 1 } });
    await expect(
      fetch(`${FAKE_TELEGRAM_BASE}/botOTRO/sendMessage`, { method: 'POST', body: '{}' }),
    ).rejects.toBeInstanceOf(UnexpectedExternalRequestError);
  });

  it('OpenAI: la primera vuelta llama a send_menu; con resultado de herramienta cierra con texto', async () => {
    const first = await (
      await fetch(OPENAI_URL, { method: 'POST', body: JSON.stringify({ input: 'hola' }) })
    ).json();
    expect(first.output[0]).toMatchObject({ type: 'function_call', name: 'send_menu' });
    const second = await (
      await fetch(OPENAI_URL, {
        method: 'POST',
        body: JSON.stringify({ input: [{ type: 'function_call_output' }] }),
      })
    ).json();
    expect(second.output[0].type).toBe('message');
    expect(ext.callsTo('openai')).toHaveLength(2);
  });

  it.each([
    ['https://api.kapso.ai/meta/whatsapp/v24.0/1/messages'],
    ['https://api.telegram.org/bot1/sendMessage'],
    ['https://example.com/'],
    [`${FAKE_KAPSO_BASE}/phone/otra-cosa`],
  ])('cualquier otra URL falla de inmediato y queda como violación (%s)', async (url) => {
    await expect(fetch(url, { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(
      UnexpectedExternalRequestError,
    );
    expect(ext.violations).toHaveLength(1);
  });

  it('el tráfico hacia la propia máquina (supertest → la app) sí pasa', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: '/' }, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve(data));
          })
          .on('error', reject);
      });
      expect(body).toBe('ok');
      expect(ext.violations).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('http/https.request hacia cualquier otro destino quedan bloqueados (p. ej. el cliente real del banco)', () => {
    expect(() => http.request('http://example.com')).toThrow(UnexpectedExternalRequestError);
    expect(() => https.request('https://example.com')).toThrow(UnexpectedExternalRequestError);
    expect(ext.violations).toHaveLength(2);
  });

  it('restore() devuelve fetch y http/https originales', () => {
    const patched = { fetch: global.fetch, https: https.request, http: http.request };
    ext.restore();
    expect(global.fetch).not.toBe(patched.fetch);
    expect(https.request).toBe(ORIGINAL.httpsRequest);
    expect(http.request).toBe(ORIGINAL.httpRequest);
    expect(https.request).not.toBe(patched.https);
    ext.install();
  });
});

describe('FakeBaneco', () => {
  it('genera QR, reporta pendiente (0) hasta markPaid y pagado (1) después', async () => {
    const bank = new FakeBaneco();
    const qr = await bank.generateQR({ transactionId: 'tx-1', amount: 40 });
    expect(qr.qrImageBase64.length).toBeGreaterThan(20);
    expect((await bank.statusQR(qr.qrId)).statusQrCode).toBe(0);
    bank.markPaid(qr.qrId);
    expect((await bank.statusQR(qr.qrId)).statusQrCode).toBe(1);
    expect(bank.generated).toHaveLength(1);
  });
});

describe('payloads de Kapso', () => {
  const secret = 's3cret';

  it('la firma la acepta el verificador real', () => {
    const { raw, headers } = inboundText(
      {
        phone: '59170001234',
        phoneNumberId: 'pn',
        wamid: 'e2e-w1',
        body: 'hola',
        eventId: 'e2e-ev1',
      },
      secret,
    );
    expect(verifyKapsoSignature(raw, headers['x-webhook-signature'], secret)).toBe(true);
    expect(verifyKapsoSignature(raw, headers['x-webhook-signature'], 'otro')).toBe(false);
    expect(headers['x-idempotency-key']).toBe('e2e-ev1');
  });

  it('el normalizador real interpreta el texto y la ubicación como espera el agente', () => {
    const text = inboundText(
      {
        phone: '59170001234',
        phoneNumberId: 'pn',
        wamid: 'e2e-w1',
        body: 'hola',
        eventId: 'e2e-ev1',
      },
      secret,
    );
    const loc = inboundLocation(
      {
        phone: '59170001234',
        phoneNumberId: 'pn',
        wamid: 'e2e-w2',
        latitude: -17.79,
        longitude: -63.19,
        eventId: 'e2e-ev2',
      },
      secret,
    );
    const parse = (raw: string) => {
      const parsed = parseKapsoEnvelopes(raw);
      if (!parsed.ok) throw new Error('no parsea');
      return buildNormalizedEvents(parsed.envelopes, 'whatsapp.message.received', 'e2e-ev');
    };

    expect(parse(text.raw)[0]).toMatchObject({
      contentType: 'text',
      text: 'hola',
      customerPhone: '59170001234',
      phoneNumberId: 'pn',
      messageId: 'e2e-w1',
    });
    expect(parse(loc.raw)[0]).toMatchObject({
      contentType: 'location',
      messageId: 'e2e-w2',
      location: { latitude: -17.79, longitude: -63.19 },
    });
  });
});

describe('snapshot', () => {
  it('diffSnapshots: idénticas → vacío; cambios de conteo o de contenido → una línea por tabla', () => {
    const a = { orders: { count: 922, hash: 'h1' }, notification_jobs: { count: 16, hash: 'h2' } };
    expect(diffSnapshots(a, { ...a })).toEqual([]);
    expect(
      diffSnapshots(a, {
        orders: { count: 923, hash: 'h1' },
        notification_jobs: { count: 16, hash: 'CAMBIO' },
      }),
    ).toEqual([
      'notification_jobs: mismas 16 filas pero el CONTENIDO cambió',
      'orders: filas 922 → 923',
    ]);
  });

  it('takeSnapshot solo hace SELECT y rechaza nombres de tabla raros', async () => {
    const queries: string[] = [];
    const client = {
      async query(text: string) {
        queries.push(text);
        if (text.includes('information_schema')) return { rows: [{ table_name: 'orders' }] };
        return { rows: [{ n: 922, h: 'abc' }] };
      },
    };
    expect(await takeSnapshot(client)).toEqual({ orders: { count: 922, hash: 'abc' } });
    for (const q of queries) expect(q.trim().toLowerCase()).toMatch(/^select/);
    await expect(
      takeSnapshot({ query: async () => ({ rows: [{ table_name: 'x"; drop table y; --' }] }) }),
    ).rejects.toThrow('nombre de tabla inesperado');
  });
});

describe('auditWrites', () => {
  const allowed = new Set(['order-1', 'sess-1']);
  const write = (sql: string, ...parameters: unknown[]) => ({ sql, parameters });

  it('acepta escrituras acotadas al E2E', () => {
    expect(
      auditWrites(
        [
          write('insert into "orders" ("id") values ($1)', 'order-1'),
          write('update "orders" set "status" = $1 where "id" = $2', 'confirmed', 'order-1'),
          write('update webhook_events set status = $1 where id = $2::uuid', 'processed', 'sess-1'),
          write(
            'update "agent_runs" set "status" = $1 where "source_message_id" = $2',
            'x',
            'e2e-abc-wamid',
          ),
        ],
        new Set([...CENTRAL_WRITE_ALLOWLIST, ...AGENT_WRITE_ALLOWLIST]),
        allowed,
        '59170001234',
      ),
    ).toEqual([]);
  });

  it('marca UPDATE/DELETE que tocan algo NO registrado, y tablas fuera de la lista', () => {
    const violations = auditWrites(
      [
        write('update "orders" set "status" = $1 where "id" = $2', 'cancelled', 'pedido-historico'),
        write('delete from "orders" where "status" = $1', 'unpaid'),
        write('insert into "products" ("code") values ($1)', 'x'),
        write('update "dashboard_users" set "role" = $1 where "id" = $2', 'admin', 'order-1'),
      ],
      CENTRAL_WRITE_ALLOWLIST,
      allowed,
      '59170001234',
    );
    expect(violations).toEqual([
      'update orders: no está acotado a ningún id/teléfono/prefijo del E2E',
      'delete from orders: no está acotado a ningún id/teléfono/prefijo del E2E',
      'insert into products: tabla fuera de la lista permitida',
      'update dashboard_users: tabla fuera de la lista permitida',
    ]);
  });

  it('WriteAudit registra solo las sentencias que escriben', () => {
    const audit = new WriteAudit();
    audit.log({ level: 'query', query: { sql: 'select 1', parameters: [] } });
    audit.log({
      level: 'query',
      query: { sql: 'update "orders" set a = $1 where id = $2', parameters: [1, 'x'] },
    });
    audit.log({ level: 'error', query: { sql: 'delete from "orders"', parameters: [] } });
    expect(audit.writes).toHaveLength(1);
  });
});

/** Kysely sobre un Postgres falso que registra el SQL y responde filas borradas configurables. */
function recordingDb<T>(deleteCount: (sql: string) => number) {
  const statements: { sql: string; parameters: unknown[] }[] = [];
  const client = {
    query: async (sql: string, parameters: unknown[] = []) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      statements.push({ sql: text, parameters });
      if (/^delete from/i.test(text)) {
        const n = deleteCount(text);
        return { command: 'DELETE', rowCount: n, rows: [] };
      }
      return { command: 'SELECT', rowCount: 0, rows: [] };
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

describe('cleanupFromManifest', () => {
  function fullManifest() {
    const m = Manifest.create(tmp(), 'run1', '59170001234');
    m.addCentral('customers', 'cust-1');
    m.addCentral('orders', 'order-1');
    m.addCentral('order_items', 'item-1', 'item-2');
    m.addCentral('payment_attempts', 'att-1');
    m.addCentral('bank_qr_charges', 'qr-1');
    m.addCentral('notification_jobs', 'job-1', 'job-2');
    m.addCentral('idempotency_keys', 'idem-1');
    m.addCentral('products', 'prod-1');
    m.addCentral('categories', 'cat-1');
    m.addCentral('cash_register_sessions', 'cash-1');
    m.addAgent('agent_conversations', 'conv-1');
    m.addAgent('agent_messages', 'msg-1');
    m.addAgent('agent_runs', 'run-1');
    m.addAgent('webhook_events', 'wh-1');
    m.addAgent('menu_sessions', 'ms-1');
    m.addAgent('menu_send_deliveries', 'md-1');
    return m;
  }

  it('cada DELETE es acotado: lleva `id in (...)` con los ids registrados MÁS una condición de origen E2E', async () => {
    const manifest = fullManifest();
    const central = recordingDb<Database>((sql) => (sql.includes('"order_items"') ? 2 : 1));
    const agent = recordingDb<AgentDatabase>(() => 1);

    const report = await cleanupFromManifest(central.db, agent.db, manifest);

    const deletes = [...central.statements, ...agent.statements].filter((s) =>
      /^delete from/i.test(s.sql),
    );
    expect(deletes).toHaveLength(16);
    for (const d of deletes) {
      expect(d.sql).toMatch(/where "id" in \(/i);
      // al menos una condición adicional de origen
      expect(d.sql.match(/ and /gi)?.length ?? 0).toBeGreaterThanOrEqual(1);
    }
    expect(report.deleted['central.order_items']).toBe(2);
    expect(report.deleted['central.orders']).toBe(1);
  });

  it('respeta el orden hijos → padres y cada base va en su propia transacción', async () => {
    const central = recordingDb<Database>(() => 1);
    const agent = recordingDb<AgentDatabase>(() => 1);
    await cleanupFromManifest(central.db, agent.db, fullManifest());

    const order = central.statements
      .filter((s) => /^delete from/i.test(s.sql))
      .map((s) => /delete from "(\w+)"/i.exec(s.sql)?.[1]);
    expect(order).toEqual([
      'notification_jobs',
      'bank_qr_charges',
      'payment_attempts',
      'order_items',
      'orders',
      'idempotency_keys',
      'customers',
      'products',
      'categories',
      'cash_register_sessions',
    ]);
    expect(central.statements[0].sql).toMatch(/^begin/i);
    expect(central.statements[central.statements.length - 1].sql).toMatch(/^commit/i);
    expect(agent.statements[0].sql).toMatch(/^begin/i);
  });

  it('si un DELETE afectaría MÁS filas que ids registrados, aborta y revierte (nunca borra de más)', async () => {
    const central = recordingDb<Database>((sql) => (sql.includes('"orders"') ? 923 : 1));
    const agent = recordingDb<AgentDatabase>(() => 1);

    await expect(cleanupFromManifest(central.db, agent.db, fullManifest())).rejects.toBeInstanceOf(
      CleanupSafetyError,
    );
    expect(central.statements.some((s) => /^rollback/i.test(s.sql))).toBe(true);
    expect(central.statements.some((s) => /^commit/i.test(s.sql))).toBe(false);
  });

  it('con el manifest vacío no ejecuta ningún DELETE (jamás un borrado genérico)', async () => {
    const central = recordingDb<Database>(() => 1);
    const agent = recordingDb<AgentDatabase>(() => 1);
    await cleanupFromManifest(central.db, agent.db, Manifest.create(tmp(), 'r', '59170001234'));
    expect(
      [...central.statements, ...agent.statements].filter((s) => /^delete/i.test(s.sql)),
    ).toEqual([]);
  });

  it('es idempotente: ids que ya no existen se reportan como alreadyGone', async () => {
    const central = recordingDb<Database>(() => 0);
    const agent = recordingDb<AgentDatabase>(() => 0);
    const report = await cleanupFromManifest(central.db, agent.db, fullManifest());
    expect(report.deleted['central.orders']).toBe(0);
    expect(report.alreadyGone['central.orders']).toBe(1);
  });
});

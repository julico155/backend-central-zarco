import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import request from 'supertest';
import type { AgentDatabase } from '../../src/database/agent-types';
import type { Database } from '../../src/database/types';
import {
  E2E_CUSTOMER_PIN,
  buildAppEnv,
  buildE2EApp,
  type E2EApp,
  type E2EAppEnv,
} from './support/app';
import { AGENT_WRITE_ALLOWLIST, CENTRAL_WRITE_ALLOWLIST, auditWrites } from './support/audit';
import { cleanupFromManifest } from './support/cleanup';
import { closeReadOnly, openAgent, openCentral, openReadOnly } from './support/connections';
import { discoverByIdentity } from './support/discover';
import { inboundLocation, inboundText } from './support/kapso-payloads';
import { Manifest } from './support/manifest';
import { E2E_PREFIX, readE2EOptions, type E2EOptions } from './support/options';
import { recheckForeignSessions, runPreflight } from './support/preflight';
import { diffSnapshots, takeSnapshot, type Snapshot } from './support/snapshot';

/**
 * E2E integral CONTRA LAS DB REALES (temporal, ventana sin clientes). Nunca corre
 * por accidente: vive fuera de `test:e2e` y exige ALLOW_REAL_DB_E2E=true.
 * Ver `npm run e2e:real-db` y `npm run e2e:cleanup`.
 *
 *  webhook WhatsApp → webhook_events (Agente) → agente (OpenAI falso) → send_menu →
 *  menu_session → pedido en Central → location webhook → LocationAttachService →
 *  quoteForOrder → QR (Banco falso) → banco paga → payment_status=paid →
 *  WhatsApp de confirmación capturado → delivery_notice → Telegram capturado.
 */

const WAIT_MS = 20_000;

async function waitFor<T>(label: string, probe: () => Promise<T | undefined | false>): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timeout esperando: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

describe('E2E real-db: WhatsApp → pedido → ubicación → pago → confirmación → delivery_notice', () => {
  let options: E2EOptions;
  let manifest: Manifest;
  let central: Kysely<Database>;
  let agent: Kysely<AgentDatabase>;
  let e2e: E2EApp;
  let appEnv: E2EAppEnv;
  let beforeCentral: Snapshot | null = null;
  let beforeAgent: Snapshot | null = null;
  let wrote = false;

  const ids = {
    productCode: '',
    eventText: '',
    wamidText: '',
    eventLocation: '',
    wamidLocation: '',
  };
  const state = {
    menuToken: '',
    orderId: '',
    qrId: '',
    openAiAfterText: 0,
    orderBody: {} as Record<string, unknown>,
  };

  const http = () => request(e2e.app.getHttpServer());
  const discover = () => discoverByIdentity(central, agent, manifest);

  function kapsoTo(): string[] {
    return e2e.externals
      .kapsoMessages()
      .map((m) => String(m.to ?? ''))
      .filter(Boolean);
  }
  const kapsoTexts = () =>
    e2e.externals
      .kapsoMessages()
      .filter((m) => m.type === 'text')
      .map((m) => String((m.text as { body?: string })?.body ?? ''));
  const noViolations = () => expect(e2e.externals.violations).toEqual([]);

  beforeAll(async () => {
    // 1) Guardas de arranque (sin abrir ninguna conexión todavía).
    options = readE2EOptions();
    const built = buildAppEnv({
      centralUrl: options.centralUrl,
      agentUrl: options.agentUrl,
      phone: options.phone,
    });
    appEnv = built.app;

    // 2) Preflight + foto "antes": solo lectura.
    const roCentral = await openReadOnly(options.centralUrl, 'e2e-preflight');
    const roAgent = await openReadOnly(options.agentUrl, 'e2e-preflight');
    try {
      await runPreflight(roCentral, roAgent, options);
      beforeCentral = await takeSnapshot(roCentral);
      beforeAgent = await takeSnapshot(roAgent);
    } finally {
      await closeReadOnly(roCentral);
      await closeReadOnly(roAgent);
    }

    // 3) Justo antes de escribir: otra vez actividad ajena.
    const recheckC = await openReadOnly(options.centralUrl, 'e2e-preflight');
    const recheckA = await openReadOnly(options.agentUrl, 'e2e-preflight');
    try {
      await recheckForeignSessions(recheckC, recheckA, options.ignoredApplicationNames);
    } finally {
      await closeReadOnly(recheckC);
      await closeReadOnly(recheckA);
    }

    // 4) Manifest + fixtures propios (cada id se anota ANTES de insertarlo).
    manifest = Manifest.create(options.manifestPath, options.runId, options.phone);
    central = openCentral(options.centralUrl, 'e2e-harness');
    agent = openAgent(options.agentUrl, 'e2e-harness');
    wrote = true;

    const run = options.runId;
    ids.productCode = `${E2E_PREFIX}${run}-lomito`;
    ids.eventText = `${E2E_PREFIX}${run}-evt-text`;
    ids.wamidText = `${E2E_PREFIX}${run}-wamid-text`;
    ids.eventLocation = `${E2E_PREFIX}${run}-evt-location`;
    ids.wamidLocation = `${E2E_PREFIX}${run}-wamid-location`;

    const cashSessionId = randomUUID();
    manifest.addCentral('cash_register_sessions', cashSessionId);
    await central
      .insertInto('cash_register_sessions')
      .values({ id: cashSessionId, opened_by: `${E2E_PREFIX}${run}`, opening_amount: '0' })
      .execute();

    const categoryId = randomUUID();
    manifest.addCentral('categories', categoryId);
    await central
      .insertInto('categories')
      .values({ id: categoryId, name: `${E2E_PREFIX}${run}-categoria` })
      .execute();

    const productId = randomUUID();
    manifest.addCentral('products', productId);
    await central
      .insertInto('products')
      .values({
        id: productId,
        code: ids.productCode,
        name: 'E2E Lomito',
        category_id: categoryId,
        price: '20.00',
      })
      .execute();

    // 5) La aplicación real, con todo lo externo falso.
    e2e = await buildE2EApp(built.env, appEnv);
  }, 120_000);

  afterAll(async () => {
    const problems: string[] = [];
    try {
      if (e2e) await e2e.close();
    } catch (error) {
      problems.push(`cierre de la app: ${(error as Error).message}`);
    }

    if (wrote) {
      try {
        await discover();
        const report = await cleanupFromManifest(central, agent, manifest);
        // eslint-disable-next-line no-console
        console.log('E2E cleanup (filas borradas):', JSON.stringify(report.deleted));
        manifest.archive();
      } catch (error) {
        problems.push(
          `CLEANUP FALLÓ (${(error as Error).message}). Corre: npm run e2e:cleanup (el manifest sigue en ${options.manifestPath}).`,
        );
      }
      await central.destroy();
      await agent.destroy();

      // Foto "después": lo preexistente tiene que estar EXACTAMENTE igual.
      if (beforeCentral && beforeAgent && problems.length === 0) {
        const c = await openReadOnly(options.centralUrl, 'e2e-verify');
        const a = await openReadOnly(options.agentUrl, 'e2e-verify');
        try {
          const diffs = [
            ...diffSnapshots(beforeCentral, await takeSnapshot(c)).map((d) => `central.${d}`),
            ...diffSnapshots(beforeAgent, await takeSnapshot(a)).map((d) => `agent.${d}`),
          ];
          if (diffs.length > 0)
            problems.push(
              `el estado posterior NO coincide con el anterior:\n - ${diffs.join('\n - ')}`,
            );
        } finally {
          await closeReadOnly(c);
          await closeReadOnly(a);
        }
      }
    }
    if (problems.length > 0) throw new Error(problems.join('\n'));
  }, 180_000);

  it('A) webhook WhatsApp → Agent DB → agente (OpenAI falso) → send_menu → menu_session', async () => {
    const { raw, headers } = inboundText(
      {
        phone: options.phone,
        phoneNumberId: appEnv.phoneNumberId,
        wamid: ids.wamidText,
        body: 'Hola, quiero ver el menú',
        eventId: ids.eventText,
      },
      appEnv.webhookSecret,
    );

    const res = await http().post('/kapso/webhook').set(headers).send(raw);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: true });

    const event = await agent
      .selectFrom('webhook_events')
      .select(['status', 'attempts'])
      .where('event_id', '=', ids.eventText)
      .executeTakeFirstOrThrow();
    expect(event.status).toBe('processed');

    expect(e2e.externals.callsTo('openai').length).toBeGreaterThanOrEqual(1);
    state.openAiAfterText = e2e.externals.callsTo('openai').length;

    const cta = e2e.externals.kapsoMessages().find((m) => m.type === 'interactive') as {
      to: string;
      interactive: { action: { parameters: { url: string } } };
    };
    expect(cta).toBeDefined();
    expect(cta.to).toBe(options.phone);
    const url = new URL(cta.interactive.action.parameters.url);
    expect(url.origin).toBe(appEnv.menuBase);
    state.menuToken = url.searchParams.get('session') ?? '';
    expect(state.menuToken.length).toBeGreaterThan(10);

    const conv = await agent
      .selectFrom('agent_conversations')
      .select('id')
      .where('customer_phone', '=', options.phone)
      .executeTakeFirstOrThrow();
    const inbound = await agent
      .selectFrom('agent_messages')
      .select('provider_message_id')
      .where('agent_conversation_id', '=', conv.id)
      .where('direction', '=', 'inbound')
      .execute();
    expect(inbound.map((m) => m.provider_message_id)).toContain(ids.wamidText);
    expect(
      await agent
        .selectFrom('menu_sessions')
        .select('id')
        .where('customer_phone', '=', options.phone)
        .execute(),
    ).toHaveLength(1);
    const delivery = await agent
      .selectFrom('menu_send_deliveries')
      .select('status')
      .where('customer_phone', '=', options.phone)
      .execute();
    expect(delivery.map((d) => d.status)).toEqual(['sent']);

    await discover();
    noViolations();
  });

  it('B) el MISMO webhook WhatsApp dos veces no duplica nada', async () => {
    const before = {
      openai: e2e.externals.callsTo('openai').length,
      kapso: e2e.externals.kapsoMessages().length,
    };
    const { raw, headers } = inboundText(
      {
        phone: options.phone,
        phoneNumberId: appEnv.phoneNumberId,
        wamid: ids.wamidText,
        body: 'Hola, quiero ver el menú',
        eventId: ids.eventText,
      },
      appEnv.webhookSecret,
    );

    const res = await http().post('/kapso/webhook').set(headers).send(raw);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, duplicate: true });
    expect(e2e.externals.callsTo('openai').length).toBe(before.openai);
    expect(e2e.externals.kapsoMessages().length).toBe(before.kapso);
    expect(
      await agent
        .selectFrom('webhook_events')
        .select('id')
        .where('event_id', '=', ids.eventText)
        .execute(),
    ).toHaveLength(1);
    expect(
      await agent
        .selectFrom('menu_sessions')
        .select('id')
        .where('customer_phone', '=', options.phone)
        .execute(),
    ).toHaveLength(1);
    noViolations();
  });

  it('C) sesión de menú → pedido en Central (delivery + QR); mismo session_id dos veces = un solo pedido', async () => {
    const session = await http().get('/menu-web/session').query({ token: state.menuToken });
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ valid: true });

    const cart = {
      session_token: state.menuToken,
      customer_name: 'E2E Cliente',
      delivery_type: 'delivery',
      payment_method: 'qr',
      items: [{ code: ids.productCode, quantity: 2 }],
      notes: 'e2e nota',
    };
    const created = await http().post('/menu-web/orders').send(cart);
    expect([200, 201]).toContain(created.status);
    state.orderId = String(created.body.id);
    state.orderBody = created.body;
    expect(state.orderId).toMatch(/^[0-9a-f-]{36}$/);

    const customer = await central
      .selectFrom('customers')
      .select('id')
      .where('phone', '=', options.phone)
      .executeTakeFirstOrThrow();
    const order = await central
      .selectFrom('orders')
      .select([
        'id',
        'channel',
        'status',
        'payment_status',
        'delivery_type',
        'delivery_quote_status',
        'subtotal_amount',
      ])
      .where('customer_id', '=', customer.id)
      .execute();
    expect(order).toHaveLength(1);
    expect(order[0]).toMatchObject({
      id: state.orderId,
      channel: 'whatsapp',
      status: 'awaiting_location',
      payment_status: 'unpaid',
      delivery_type: 'delivery',
      delivery_quote_status: 'pending',
    });
    expect(Number(order[0].subtotal_amount)).toBe(40);
    await discover();

    // Notificaciones asíncronas de la creación: pedido recibido + QR real (Banco falso).
    const charge = await waitFor('bank_qr_charges del pedido', async () =>
      central
        .selectFrom('bank_qr_charges')
        .select(['qr_id', 'status', 'amount'])
        .where('order_id', '=', state.orderId)
        .executeTakeFirst(),
    );
    expect(charge.status).toBe('pending');
    expect(Number(charge.amount)).toBe(40);
    state.qrId = charge.qr_id;
    await waitFor('jobs order_received + qr_confirmation enviados', async () => {
      const jobs = await central
        .selectFrom('notification_jobs')
        .select(['kind', 'status'])
        .where('target_ref', '=', state.orderId)
        .execute();
      return ['order_received', 'qr_confirmation'].every((k) =>
        jobs.some((j) => j.kind === k && j.status === 'sent'),
      );
    });
    expect(kapsoTexts().some((t) => t.includes('Recibimos tu pedido'))).toBe(true);
    expect(e2e.externals.kapsoMessages().some((m) => m.type === 'image')).toBe(true);

    // Reintento del MISMO carrito con la MISMA sesión: sin pedido nuevo ni QR nuevo.
    const retry = await http().post('/menu-web/orders').send(cart);
    expect([200, 201]).toContain(retry.status);
    expect(retry.body.id).toBe(state.orderId);
    const other = await http()
      .post('/menu-web/orders')
      .send({ ...cart, items: [{ code: ids.productCode, quantity: 5 }] });
    expect(other.status).toBe(409);

    expect(
      await central
        .selectFrom('orders')
        .select('id')
        .where('customer_id', '=', customer.id)
        .execute(),
    ).toHaveLength(1);
    expect(
      await central
        .selectFrom('bank_qr_charges')
        .select('id')
        .where('order_id', '=', state.orderId)
        .execute(),
    ).toHaveLength(1);
    expect(e2e.baneco.generated).toHaveLength(1);
    await discover();
    noViolations();
  });

  it('D) webhook de ubicación → persiste en Agent DB, sin turno OpenAI → LocationAttachService → quoteForOrder', async () => {
    const before = {
      openai: e2e.externals.callsTo('openai').length,
      telegram: e2e.externals.callsTo('telegram').length,
    };
    const { raw, headers } = inboundLocation(
      {
        phone: options.phone,
        phoneNumberId: appEnv.phoneNumberId,
        wamid: ids.wamidLocation,
        latitude: E2E_CUSTOMER_PIN.latitude,
        longitude: E2E_CUSTOMER_PIN.longitude,
        eventId: ids.eventLocation,
      },
      appEnv.webhookSecret,
    );

    const res = await http().post('/kapso/webhook').set(headers).send(raw);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: true });

    const order = await central
      .selectFrom('orders')
      .select([
        'status',
        'delivery_latitude',
        'delivery_longitude',
        'delivery_quote_status',
        'delivery_base_amount',
        'delivery_surcharge_amount',
        'subtotal_amount',
        'total_amount',
        'payment_status',
      ])
      .where('id', '=', state.orderId)
      .executeTakeFirstOrThrow();
    expect(order.delivery_latitude).toBe(E2E_CUSTOMER_PIN.latitude);
    expect(order.delivery_longitude).toBe(E2E_CUSTOMER_PIN.longitude);
    expect(order.delivery_quote_status).toBe('quoted');
    expect(order.status).toBe('confirmed');
    expect(order.payment_status).toBe('unpaid');
    expect(Number(order.delivery_base_amount)).toBeGreaterThan(0);
    expect(Number(order.total_amount)).toBeCloseTo(
      Number(order.subtotal_amount) +
        Number(order.delivery_base_amount) +
        Number(order.delivery_surcharge_amount),
      2,
    );

    // Persistido en el historial del agente y SIN turno de OpenAI.
    const conv = await agent
      .selectFrom('agent_conversations')
      .select('id')
      .where('customer_phone', '=', options.phone)
      .executeTakeFirstOrThrow();
    const locationMsg = await agent
      .selectFrom('agent_messages')
      .select(['content_type', 'direction'])
      .where('agent_conversation_id', '=', conv.id)
      .where('provider_message_id', '=', ids.wamidLocation)
      .executeTakeFirstOrThrow();
    expect(locationMsg).toMatchObject({ content_type: 'location', direction: 'inbound' });
    expect(e2e.externals.callsTo('openai').length).toBe(before.openai);
    // Todavía no está pagado: ningún aviso a las motos.
    expect(e2e.externals.callsTo('telegram').length).toBe(before.telegram);

    // El mismo webhook otra vez: duplicado, sin nada nuevo.
    const again = await http().post('/kapso/webhook').set(headers).send(raw);
    expect(again.body).toMatchObject({ ok: true, duplicate: true });
    expect(e2e.externals.callsTo('openai').length).toBe(before.openai);
    await discover();
    noViolations();
  });

  it('E) el banco reporta pagado (callback duplicado y concurrente) → paid → WhatsApp de confirmación → delivery_notice por Telegram', async () => {
    e2e.baneco.markPaid(state.qrId);
    const notify = () =>
      http()
        .post('/api/qrsimple/notifyPaymentQR')
        .send({ Payment: { qrId: state.qrId } });

    const [first, second] = await Promise.all([notify(), notify()]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.responseCode).toBe(0);
    expect(second.body.responseCode).toBe(0);

    await waitFor('pedido pagado', async () => {
      const o = await central
        .selectFrom('orders')
        .select('payment_status')
        .where('id', '=', state.orderId)
        .executeTakeFirst();
      return o?.payment_status === 'paid';
    });
    await waitFor('jobs payment_decision + delivery_notice enviados', async () => {
      const attempts = await central
        .selectFrom('payment_attempts')
        .select('id')
        .where('order_id', '=', state.orderId)
        .execute();
      const refs = [state.orderId, ...attempts.map((a) => a.id)];
      const jobs = await central
        .selectFrom('notification_jobs')
        .select(['kind', 'status'])
        .where('target_ref', 'in', refs)
        .execute();
      return ['payment_decision', 'delivery_notice'].every((k) =>
        jobs.some((j) => j.kind === k && j.status === 'sent'),
      );
    });

    // Un solo pago efectivo.
    const attempts = await central
      .selectFrom('payment_attempts')
      .select(['id', 'review_status'])
      .where('order_id', '=', state.orderId)
      .execute();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].review_status).toBe('accepted');
    const charge = await central
      .selectFrom('bank_qr_charges')
      .select('status')
      .where('order_id', '=', state.orderId)
      .executeTakeFirstOrThrow();
    expect(charge.status).toBe('confirmed');

    // WhatsApp de confirmación: capturado, al teléfono E2E, una sola vez.
    const confirmations = kapsoTexts().filter((t) => t.includes('Tu pago fue confirmado'));
    expect(confirmations).toHaveLength(1);

    // Telegram delivery_notice: capturado, una sola vez, al chat falso.
    const telegram = e2e.externals.telegramMessages();
    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toMatchObject({ chat_id: appEnv.telegramChatId, parse_mode: 'HTML' });
    const text = String(telegram[0].text);
    expect(text).toContain('Cliente: E2E Cliente');
    expect(text).toContain(`Teléfono: https://wa.me/${options.phone}`);
    expect(text).toContain('2x E2E Lomito');
    expect(text).toContain('COBRAR ENVÍO');
    expect(text).toContain(`query=${E2E_CUSTOMER_PIN.latitude},${E2E_CUSTOMER_PIN.longitude}`);

    await discover();
    noViolations();
  });

  it('F) idempotencia final: callback bancario, delivery_notice, creación de pedido y webhook de nuevo', async () => {
    const before = {
      kapso: e2e.externals.kapsoMessages().length,
      telegram: e2e.externals.telegramMessages().length,
      openai: e2e.externals.callsTo('openai').length,
    };

    const third = await http()
      .post('/api/qrsimple/notifyPaymentQR')
      .send({ Payment: { qrId: state.qrId } });
    expect(third.body.responseCode).toBe(0);

    // Intento duplicado de delivery_notice: mismo (kind, target_ref) ⇒ ningún envío nuevo.
    const { DeliveryNoticeService } =
      await import('../../src/delivery-notice/delivery-notice.service');
    const notice = e2e.app.get(DeliveryNoticeService);
    await notice.tryNotify(state.orderId);
    await notice.tryNotify(state.orderId);

    const cart = {
      session_token: state.menuToken,
      customer_name: 'E2E Cliente',
      delivery_type: 'delivery',
      payment_method: 'qr',
      items: [{ code: ids.productCode, quantity: 2 }],
      notes: 'e2e nota',
    };
    const retry = await http().post('/menu-web/orders').send(cart);
    expect(retry.body.id).toBe(state.orderId);

    const { raw, headers } = inboundText(
      {
        phone: options.phone,
        phoneNumberId: appEnv.phoneNumberId,
        wamid: ids.wamidText,
        body: 'Hola, quiero ver el menú',
        eventId: ids.eventText,
      },
      appEnv.webhookSecret,
    );
    expect((await http().post('/kapso/webhook').set(headers).send(raw)).body).toMatchObject({
      duplicate: true,
    });

    expect(e2e.externals.telegramMessages().length).toBe(before.telegram);
    expect(e2e.externals.kapsoMessages().length).toBe(before.kapso);
    expect(e2e.externals.callsTo('openai').length).toBe(before.openai);
    expect(e2e.externals.callsTo('openai').length).toBe(state.openAiAfterText);

    const customer = await central
      .selectFrom('customers')
      .select('id')
      .where('phone', '=', options.phone)
      .executeTakeFirstOrThrow();
    expect(
      await central
        .selectFrom('orders')
        .select('id')
        .where('customer_id', '=', customer.id)
        .execute(),
    ).toHaveLength(1);
    const attempts = await central
      .selectFrom('payment_attempts')
      .select('id')
      .where('order_id', '=', state.orderId)
      .execute();
    expect(attempts).toHaveLength(1);
    const jobs = await central
      .selectFrom('notification_jobs')
      .select(['kind'])
      .where('target_ref', 'in', [state.orderId, ...attempts.map((a) => a.id)])
      .execute();
    expect(jobs.filter((j) => j.kind === 'delivery_notice')).toHaveLength(1);
    expect(jobs.filter((j) => j.kind === 'payment_decision')).toHaveLength(1);
    await discover();
  });

  it('G) nada salió a la red real y la aplicación solo escribió lo del E2E', async () => {
    noViolations();
    // Todo lo que Kapso "envió" fue al teléfono E2E.
    expect(new Set(kapsoTo())).toEqual(new Set([options.phone]));

    await discover();
    const allowedRefs = new Set<string>([
      ...Object.values(manifest.data.central).flat(),
      ...Object.values(manifest.data.agent).flat(),
    ]);
    expect(
      auditWrites(e2e.centralAudit.writes, CENTRAL_WRITE_ALLOWLIST, allowedRefs, options.phone),
    ).toEqual([]);
    expect(
      auditWrites(e2e.agentAudit.writes, AGENT_WRITE_ALLOWLIST, allowedRefs, options.phone),
    ).toEqual([]);
  });
});

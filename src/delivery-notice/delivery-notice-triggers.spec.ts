import { Kysely, PostgresDialect } from 'kysely';
import type { Database } from '../database/types';
import { NotificationsOutService } from '../notifications-out/notifications-out.service';
import { OrdersService } from '../orders/orders.service';
import { PaymentAttemptsService } from '../payment-attempts/payment-attempts.service';
import { DeliveryNoticeService } from './delivery-notice.service';

/**
 * Wiring de punta a punta SIN red ni base real: los servicios de verdad
 * (PaymentAttemptsService / OrdersService → DeliveryNoticeService →
 * NotificationsOutService) sobre un Postgres falso que emula el UNIQUE
 * (kind, target_ref) de notification_jobs, con Telegram y Kapso falsos.
 */

const ORDER_ID = '00000000-0000-0000-0000-0000000000aa';

type Row = Record<string, unknown>;

interface Job {
  id: string;
  kind: string;
  channel: string;
  targetRef: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'sending' | 'sent' | 'failed';
  attempts: number;
  claimToken: string | null;
  externalMessageId: string | null;
}

interface World {
  order: Row;
  jobs: Job[];
}

function readyOrder(overrides: Row = {}): Row {
  return {
    id: ORDER_ID,
    order_number: 'ORD-260902-009',
    customer_id: 'cust-1',
    customer_name: 'Ana',
    delivery_type: 'delivery',
    payment_method: 'qr',
    payment_status: 'paid',
    delivery_quote_status: 'quoted',
    delivery_latitude: -17.78,
    delivery_longitude: -63.18,
    delivery_distance_meters: 5762,
    delivery_base_amount: '10.00',
    delivery_surcharge_amount: '3.00',
    subtotal_amount: '48.00',
    total_amount: '61.00',
    delivery_fee_paid: null,
    notes: null,
    ...overrides,
  };
}

/** Postgres falso: responde a las consultas del aviso y emula el outbox con su UNIQUE. */
function fakePostgres(world: World) {
  let sequence = 0;
  const execute = async (sqlText: string, parameters: readonly unknown[]) => {
    const text = sqlText.replace(/\s+/g, ' ').trim().toLowerCase();
    const rows = (data: Row[]) => ({ command: 'SELECT', rowCount: data.length, rows: data });

    if (text.startsWith('select') && text.includes('from "orders"')) return rows([world.order]);
    if (text.includes('from "order_items"')) {
      return rows([{ product_name_snapshot: 'Lomito', quantity: 1 }]);
    }
    if (text.includes('from "order_promotions"')) return rows([]);
    if (text.includes('from "customers"')) return rows([{ phone: '59170000000' }]);
    if (text.includes('from "payment_proofs"')) return rows([]);

    if (text.startsWith('insert into "notification_jobs"')) {
      const [kind, channel, targetRef, payload] = parameters as string[];
      const existing = world.jobs.find((j) => j.kind === kind && j.targetRef === targetRef);
      if (existing) return { command: 'INSERT', rowCount: 0, rows: [] };
      const job: Job = {
        id: `job-${(sequence += 1)}`,
        kind,
        channel,
        targetRef,
        payload: JSON.parse(payload) as Record<string, unknown>,
        status: 'pending',
        attempts: 0,
        claimToken: null,
        externalMessageId: null,
      };
      world.jobs.push(job);
      return { command: 'INSERT', rowCount: 1, rows: [{ id: job.id }] };
    }
    if (text.startsWith('select "id" from "notification_jobs"')) {
      const [kind, targetRef] = parameters as string[];
      const found = world.jobs.find((j) => j.kind === kind && j.targetRef === targetRef);
      return rows(found ? [{ id: found.id }] : []);
    }
    if (text.startsWith("update notification_jobs set status = 'sending'")) {
      const job = world.jobs.find((j) => parameters.includes(j.id));
      if (!job || (job.status !== 'pending' && job.status !== 'failed')) {
        return { command: 'UPDATE', rowCount: 0, rows: [] };
      }
      job.status = 'sending';
      job.attempts += 1;
      job.claimToken = `00000000-0000-0000-0000-${String((sequence += 1)).padStart(12, '0')}`;
      return {
        command: 'UPDATE',
        rowCount: 1,
        rows: [
          {
            id: job.id,
            kind: job.kind,
            channel: job.channel,
            payload: job.payload,
            attempts: job.attempts,
            claim_token: job.claimToken,
          },
        ],
      };
    }
    if (text.startsWith("update notification_jobs set status = 'sent'")) {
      const job = world.jobs.find((j) => parameters.includes(j.id));
      if (job) {
        job.status = 'sent';
        job.externalMessageId = (parameters[0] as string | null) ?? null;
      }
      return { command: 'UPDATE', rowCount: 1, rows: [] };
    }
    if (text.startsWith("update notification_jobs set status = 'failed'")) {
      const job = world.jobs.find((j) => parameters.includes(j.id));
      if (job) job.status = 'failed';
      return { command: 'UPDATE', rowCount: 1, rows: [] };
    }
    throw new Error(`SQL inesperado: ${text}`);
  };

  const client = {
    query: (sqlText: string, parameters: readonly unknown[]) => execute(sqlText, parameters),
    release: () => undefined,
  };
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: { connect: async () => client, end: async () => undefined } as never,
    }),
  });
}

function setupNotice(orderOverrides: Row = {}, seededJobs: Job[] = []) {
  const world: World = { order: readyOrder(orderOverrides), jobs: [...seededJobs] };
  const telegram = { send: jest.fn().mockResolvedValue({ ok: true, messageId: '900' }) };
  const kapso = { sendText: jest.fn() };
  const db = fakePostgres(world);
  const outbox = new NotificationsOutService(db, telegram as never, kapso as never);
  const config = {
    get: jest
      .fn()
      .mockReturnValue({ botToken: 'tok', chatId: '-100', handoffChatId: '', apiBaseUrl: '' }),
  };
  const deliveryNotice = new DeliveryNoticeService(db, outbox, config as never);
  const noticeJobs = () => world.jobs.filter((j) => j.kind === 'delivery_notice');
  return { world, telegram, deliveryNotice, noticeJobs };
}

/** Cadena Kysely genérica: cualquier método encadena, los terminales devuelven el dato de la tabla. */
function chain(data: { one?: unknown; many?: unknown[] }) {
  const c: Record<string, unknown> = {};
  for (const method of ['select', 'selectAll', 'where', 'orderBy', 'set', 'forUpdate']) {
    c[method] = () => c;
  }
  c.returning = () => c;
  c.returningAll = () => c;
  c.execute = async () => data.many ?? [];
  c.executeTakeFirst = async () => data.one;
  c.executeTakeFirstOrThrow = async () => data.one;
  return c;
}

function fakePaymentAttemptsDb() {
  const attempt = {
    id: 'att-1',
    order_id: ORDER_ID,
    customer_id: 'cust-1',
    opened_at: new Date(),
    opened_as: 'normal',
    review_status: 'accepted',
    reviewed_at: new Date(),
  };
  const trx = {
    updateTable: (table: string) =>
      chain({ one: table === 'payment_attempts' ? attempt : { customer_id: 'cust-1' } }),
    selectFrom: () =>
      chain({
        one: { register_session_id: 'reg-1', payment_method: 'qr', split_cash_confirmed_at: null },
      }),
  };
  return { transaction: () => ({ execute: (cb: (t: unknown) => unknown) => cb(trx) }) };
}

function paymentAttempts(deliveryNotice: DeliveryNoticeService) {
  return new PaymentAttemptsService(
    fakePaymentAttemptsDb() as never,
    { notifyNow: jest.fn().mockResolvedValue(undefined) } as never,
    { assertOpenSessionId: jest.fn() } as never,
    deliveryNotice,
  );
}

function cashOrders(deliveryNotice: DeliveryNoticeService) {
  const pending = readyOrder({
    payment_method: 'cash',
    payment_status: 'unpaid',
    status: 'confirmed',
    cash_confirmed_at: null,
    split_cash_confirmed_at: null,
    register_session_id: null,
    created_at: new Date(),
  });
  const confirmed = { ...pending, payment_status: 'paid', cash_confirmed_at: new Date() };
  const trx = {
    selectFrom: () => chain({ one: pending }),
    updateTable: () => chain({ one: confirmed }),
  };
  const db = {
    transaction: () => ({ execute: (cb: (t: unknown) => unknown) => cb(trx) }),
    selectFrom: () => chain({ many: [] }),
  };
  const notifications = { notifyNow: jest.fn().mockResolvedValue(undefined) };
  const service = new OrdersService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    notifications as never,
    { assertOpenSessionId: jest.fn().mockResolvedValue('reg-1') } as never,
    {} as never,
    {} as never,
    deliveryNotice,
  );
  return { service, notifications };
}

describe('disparo de delivery_notice — pago QR aceptado (PaymentAttemptsService)', () => {
  it('A) QR aceptado con la orden lista (delivery+paid+quoted+lat/lng): crea UN delivery_notice y manda UN Telegram', async () => {
    const h = setupNotice();

    await paymentAttempts(h.deliveryNotice).decide('att-1', 'accepted');

    expect(h.noticeJobs()).toHaveLength(1);
    expect(h.noticeJobs()[0]).toMatchObject({
      channel: 'telegram',
      targetRef: ORDER_ID,
      status: 'sent',
      externalMessageId: '900',
    });
    expect(h.telegram.send).toHaveBeenCalledTimes(1);
    expect(h.telegram.send.mock.calls[0][0]).toMatchObject({
      chatRef: 'delivery-group',
      parseMode: 'HTML',
    });
    expect(h.telegram.send.mock.calls[0][0].text).toContain('ORD-009');
  });

  it('A) confirmPresencial aceptado también dispara exactamente una vez', async () => {
    const h = setupNotice();
    const service = paymentAttempts(h.deliveryNotice);
    // Hay un intento vivo: confirmPresencial decide sobre ese mismo (CAS de decide).
    (service as unknown as { db: unknown }).db = {
      ...(service as unknown as { db: object }).db,
      selectFrom: () => chain({ one: { id: 'att-1' } }),
    };

    await service.confirmPresencial(ORDER_ID, 'accepted');

    expect(h.noticeJobs()).toHaveLength(1);
    expect(h.telegram.send).toHaveBeenCalledTimes(1);
  });

  it('A) un pago RECHAZADO no crea delivery_notice', async () => {
    const h = setupNotice({ payment_status: 'rejected' });

    await paymentAttempts(h.deliveryNotice).decide('att-1', 'rejected');

    expect(h.noticeJobs()).toHaveLength(0);
    expect(h.telegram.send).not.toHaveBeenCalled();
  });

  it.each([
    [
      'split con la pata efectivo pendiente (payment_status sigue unpaid)',
      { payment_status: 'unpaid' },
    ],
    ['cotización todavía pendiente', { delivery_quote_status: 'pending' }],
    ['cotización manual pendiente', { delivery_quote_status: 'pending_manual' }],
    ['sin ubicación', { delivery_latitude: null, delivery_longitude: null }],
    ['pedido de retiro (no delivery)', { delivery_type: 'pickup' }],
  ])(
    'C) QR aceptado pero la orden no está completa — %s → NO crea delivery_notice',
    async (_l, order) => {
      const h = setupNotice(order);

      await paymentAttempts(h.deliveryNotice).decide('att-1', 'accepted');

      expect(h.noticeJobs()).toHaveLength(0);
      expect(h.telegram.send).not.toHaveBeenCalled();
    },
  );
});

describe('disparo de delivery_notice — efectivo confirmado (OrdersService.confirmCash)', () => {
  it('B) efectivo confirmado con la orden lista: crea UN delivery_notice (QUIERE EFECTIVO) y manda UN Telegram', async () => {
    const h = setupNotice({ payment_method: 'cash' });
    const { service, notifications } = cashOrders(h.deliveryNotice);

    await service.confirmCash(ORDER_ID);

    expect(h.noticeJobs()).toHaveLength(1);
    expect(h.telegram.send).toHaveBeenCalledTimes(1);
    expect(h.telegram.send.mock.calls[0][0].text).toContain('<b>QUIERE EFECTIVO</b>');
    // el aviso al grupo ya NO sale por el texto plano viejo
    expect(
      notifications.notifyNow.mock.calls.filter(
        ([job]) => job.kind === 'cash_confirmed_delivery_notice',
      ),
    ).toHaveLength(0);
  });

  it.each([
    ['cotización pendiente', { delivery_quote_status: 'pending' }],
    ['sin ubicación', { delivery_latitude: null }],
    ['no delivery', { delivery_type: 'pickup' }],
  ])(
    'C) efectivo confirmado pero la orden no está completa — %s → NO crea delivery_notice',
    async (_l, order) => {
      const h = setupNotice({ payment_method: 'cash', ...order });
      const { service } = cashOrders(h.deliveryNotice);

      await service.confirmCash(ORDER_ID);

      expect(h.noticeJobs()).toHaveLength(0);
      expect(h.telegram.send).not.toHaveBeenCalled();
    },
  );
});

describe('D) dedupe: ya existe delivery_notice del mismo pedido', () => {
  const alreadySent: Job = {
    id: 'job-old',
    kind: 'delivery_notice',
    channel: 'telegram',
    targetRef: ORDER_ID,
    payload: { chatRef: 'delivery-group', text: 'viejo', parseMode: 'HTML' },
    status: 'sent',
    attempts: 1,
    claimToken: null,
    externalMessageId: '1',
  };

  it('un job ya enviado impide un segundo envío, venga por QR, efectivo o cotización', async () => {
    const h = setupNotice({}, [alreadySent]);

    await paymentAttempts(h.deliveryNotice).decide('att-1', 'accepted');
    await h.deliveryNotice.tryNotify(ORDER_ID);

    expect(h.noticeJobs()).toHaveLength(1);
    expect(h.noticeJobs()[0].id).toBe('job-old');
    expect(h.telegram.send).not.toHaveBeenCalled();
  });

  it('dos disparos seguidos (pago y luego cotización) mandan UN solo Telegram y dejan UN solo job', async () => {
    const h = setupNotice();

    await paymentAttempts(h.deliveryNotice).decide('att-1', 'accepted');
    await h.deliveryNotice.tryNotify(ORDER_ID);
    await h.deliveryNotice.tryNotify(ORDER_ID);

    expect(h.noticeJobs()).toHaveLength(1);
    expect(h.telegram.send).toHaveBeenCalledTimes(1);
  });

  it('un job enviándose (otro proceso lo tiene) tampoco se duplica', async () => {
    const h = setupNotice({}, [{ ...alreadySent, status: 'sending', claimToken: 'x' }]);

    await h.deliveryNotice.tryNotify(ORDER_ID);

    expect(h.noticeJobs()).toHaveLength(1);
    expect(h.telegram.send).not.toHaveBeenCalled();
  });
});

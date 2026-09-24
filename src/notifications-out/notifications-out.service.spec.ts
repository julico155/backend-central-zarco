import { Kysely, PostgresDialect } from 'kysely';
import type { Database } from '../database/types';
import { NotificationsOutService } from './notifications-out.service';

type JobStatus = 'pending' | 'sending' | 'sent' | 'failed';

interface JobState {
  status: JobStatus;
  attempts: number;
  claimToken: string | null;
  leaseExpired: boolean;
  due: boolean;
  externalMessageId: string | null;
  lastErrorCode: string | null;
}

const job = (overrides: Partial<JobState> = {}): JobState => ({
  status: 'pending',
  attempts: 0,
  claimToken: null,
  leaseExpired: false,
  due: true,
  externalMessageId: null,
  lastErrorCode: null,
  ...overrides,
});

function claimed(state: JobState) {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    kind: 'test_notice',
    channel: 'telegram',
    payload: { chatRef: 'staff-group', text: 'hola' },
    attempts: state.attempts,
    claim_token: state.claimToken!,
  };
}

/**
 * Simula solamente las operaciones SQL del outbox. No hay DB: permite probar
 * que el servicio solo manda después de un claim y que el token protege el
 * cierre del lease.
 */
function fakeDb(state: JobState) {
  const queries: string[] = [];
  let sequence = 0;

  const execute = async (query: { sql: string; parameters: readonly unknown[] }) => {
    const text = query.sql.replace(/\s+/g, ' ').trim().toLowerCase();
    queries.push(text);

    const claim = () => {
      state.status = 'sending';
      state.attempts += 1;
      state.claimToken = `00000000-0000-0000-0000-${String(++sequence).padStart(12, '0')}`;
      state.leaseExpired = false;
      return { command: 'UPDATE', rowCount: 1, rows: [claimed(state)] };
    };

    if (text.startsWith('with claimable as')) {
      const recoverable =
        state.attempts < 8 &&
        (((state.status === 'pending' || state.status === 'failed') && state.due) ||
          (state.status === 'sending' && state.leaseExpired));
      return recoverable ? claim() : { command: 'UPDATE', rowCount: 0, rows: [] };
    }

    if (text.startsWith("update notification_jobs set status = 'sending'")) {
      const claimable =
        state.attempts < 8 &&
        (state.status === 'pending' || state.status === 'failed') &&
        state.due;
      return claimable ? claim() : { command: 'UPDATE', rowCount: 0, rows: [] };
    }

    if (text.startsWith("update notification_jobs set status = 'sent'")) {
      const ownsClaim = state.status === 'sending' && query.parameters.includes(state.claimToken);
      if (ownsClaim) {
        state.status = 'sent';
        state.externalMessageId =
          (query.parameters.find((value) => value !== state.claimToken) as string | null) ?? null;
        state.claimToken = null;
        state.leaseExpired = false;
        state.lastErrorCode = null;
      }
      return { command: 'UPDATE', rowCount: ownsClaim ? 1 : 0, rows: [] };
    }

    if (text.startsWith("update notification_jobs set status = 'failed'")) {
      const ownsClaim = state.status === 'sending' && query.parameters.includes(state.claimToken);
      if (ownsClaim) {
        state.status = 'failed';
        state.claimToken = null;
        state.leaseExpired = false;
        state.due = false;
        state.lastErrorCode = 'gateway_error';
      }
      return { command: 'UPDATE', rowCount: ownsClaim ? 1 : 0, rows: [] };
    }

    throw new Error(`Unexpected SQL: ${text}`);
  };

  const client = {
    query: (sql: string, parameters: readonly unknown[]) => execute({ sql, parameters }),
    release: () => undefined,
  };
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: {
        connect: async () => client,
        end: async () => undefined,
      } as never,
    }),
  });

  return {
    db,
    queries,
  };
}

function setup(state = job()) {
  const { db, queries } = fakeDb(state);
  const telegram = {
    send: jest.fn().mockResolvedValue({ ok: true, messageId: '123' }),
  };
  const kapso = {
    sendText: jest.fn().mockResolvedValue({ ok: true, wamid: 'wamid-1' }),
    sendLocationRequest: jest.fn().mockResolvedValue({ ok: true, wamid: 'wamid-loc' }),
    uploadImage: jest.fn().mockResolvedValue({ ok: true, mediaId: 'media-1' }),
    sendImageByMediaId: jest.fn().mockResolvedValue({ ok: true, wamid: 'wamid-img' }),
  };
  const service = new NotificationsOutService(db, telegram as never, kapso as never);
  const privateService = service as unknown as { enqueue(job: unknown): Promise<string> };
  jest.spyOn(privateService, 'enqueue').mockResolvedValue('00000000-0000-0000-0000-000000000001');
  return { service, telegram, kapso, queries, state };
}

describe('NotificationsOutService ownership claims', () => {
  it('claims pending once, sends once, and clears the claim while saving external_message_id', async () => {
    const h = setup();

    await h.service.notifyNow({
      channel: 'telegram',
      kind: 'test_notice',
      targetRef: 'order-1',
      payload: { chatRef: 'staff-group', text: 'hola' },
    });

    expect(h.telegram.send).toHaveBeenCalledTimes(1);
    expect(h.state).toMatchObject({
      status: 'sent',
      attempts: 1,
      claimToken: null,
      externalMessageId: '123',
    });
    expect(h.queries[0]).toContain('claim_token = gen_random_uuid()');
    expect(h.queries[0]).toContain('claimed_until = now()');
  });

  it.each<JobStatus>(['sent', 'sending'])('does not resend a %s job', async (status) => {
    const h = setup(
      job({
        status,
        claimToken: status === 'sending' ? '00000000-0000-0000-0000-000000000009' : null,
      }),
    );

    await h.service.notifyNow({
      channel: 'telegram',
      kind: 'test_notice',
      targetRef: 'order-1',
      payload: { chatRef: 'staff-group', text: 'hola' },
    });

    expect(h.telegram.send).not.toHaveBeenCalled();
    expect(h.state.status).toBe(status);
  });

  it('reclaims a due failed job exactly once', async () => {
    const h = setup(job({ status: 'failed', attempts: 1, due: true }));

    await h.service.notifyNow({
      channel: 'telegram',
      kind: 'test_notice',
      targetRef: 'order-1',
      payload: { chatRef: 'staff-group', text: 'hola' },
    });

    expect(h.telegram.send).toHaveBeenCalledTimes(1);
    expect(h.state).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('allows only one concurrent notifyNow caller to own a job', async () => {
    const h = setup();
    const input = {
      channel: 'telegram' as const,
      kind: 'test_notice',
      targetRef: 'order-1',
      payload: { chatRef: 'staff-group', text: 'hola' },
    };

    await Promise.all([h.service.notifyNow(input), h.service.notifyNow(input)]);

    expect(h.telegram.send).toHaveBeenCalledTimes(1);
    expect(h.state).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('recovery skips a sending job with a valid lease', async () => {
    const h = setup(
      job({
        status: 'sending',
        claimToken: '00000000-0000-0000-0000-000000000010',
        leaseExpired: false,
      }),
    );

    await expect(h.service.recoverFailedJobs()).resolves.toEqual({ claimed: 0 });
    expect(h.telegram.send).not.toHaveBeenCalled();
  });

  it('recovery reclaims a sending job whose lease expired', async () => {
    const h = setup(
      job({
        status: 'sending',
        claimToken: '00000000-0000-0000-0000-000000000010',
        leaseExpired: true,
      }),
    );

    await expect(h.service.recoverFailedJobs()).resolves.toEqual({ claimed: 1 });
    expect(h.telegram.send).toHaveBeenCalledTimes(1);
    expect(h.queries[0]).toContain('for update skip locked');
  });

  it('claims the next recovery job only after dispatching the previous one', async () => {
    const h = setup();
    const first = claimed(job({ claimToken: '00000000-0000-0000-0000-000000000021' }));
    const second = claimed(job({ claimToken: '00000000-0000-0000-0000-000000000022' }));
    const privateService = h.service as unknown as {
      claimNextRecoverable(): Promise<ReturnType<typeof claimed> | undefined>;
      dispatch(row: ReturnType<typeof claimed>): Promise<void>;
    };
    const claimNext = jest
      .spyOn(privateService, 'claimNextRecoverable')
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(undefined);
    const dispatch = jest.spyOn(privateService, 'dispatch').mockResolvedValue(undefined);

    await expect(h.service.recoverFailedJobs(2)).resolves.toEqual({ claimed: 2 });

    expect(dispatch).toHaveBeenCalledWith(first);
    expect(dispatch).toHaveBeenCalledWith(second);
    expect(claimNext.mock.invocationCallOrder[1]).toBeGreaterThan(
      dispatch.mock.invocationCallOrder[0],
    );
  });

  it('does not let a stale claim mark a newer owner sent or failed', async () => {
    const h = setup(
      job({ status: 'sending', attempts: 2, claimToken: '00000000-0000-0000-0000-000000000011' }),
    );
    const privateService = h.service as unknown as {
      markSent(id: string, token: string, externalMessageId: string): Promise<void>;
      markFailed(id: string, token: string, attempts: number): Promise<void>;
    };

    await privateService.markSent(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000012',
      'old',
    );
    await privateService.markFailed(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000012',
      2,
    );

    expect(h.state).toMatchObject({
      status: 'sending',
      claimToken: '00000000-0000-0000-0000-000000000011',
    });
  });

  it('clears the claim and schedules backoff after a send failure', async () => {
    const h = setup();
    h.telegram.send.mockRejectedValueOnce(new Error('down'));

    await h.service.notifyNow({
      channel: 'telegram',
      kind: 'test_notice',
      targetRef: 'order-1',
      payload: { chatRef: 'staff-group', text: 'hola' },
    });

    expect(h.state).toMatchObject({
      status: 'failed',
      claimToken: null,
      due: false,
      lastErrorCode: 'gateway_error',
    });
  });

  it('does not reclaim after MAX_ATTEMPTS', async () => {
    const h = setup(job({ status: 'failed', attempts: 8, due: true }));

    await h.service.notifyNow({
      channel: 'telegram',
      kind: 'test_notice',
      targetRef: 'order-1',
      payload: { chatRef: 'staff-group', text: 'hola' },
    });
    await expect(h.service.recoverFailedJobs()).resolves.toEqual({ claimed: 0 });

    expect(h.telegram.send).not.toHaveBeenCalled();
  });
});

describe('NotificationsOutService transportes directos (sin gateway de Sarco)', () => {
  type Internals = {
    customerPhone(id: string): Promise<string>;
    loadImage(url: string): Promise<{ bytes: Buffer; mimeType: string }>;
    send(
      channel: string,
      kind: string,
      payload: Record<string, unknown>,
    ): Promise<string | undefined>;
  };
  function direct() {
    const h = setup();
    const internals = h.service as unknown as Internals;
    jest.spyOn(internals, 'customerPhone').mockResolvedValue('59170000000');
    return { ...h, internals };
  }

  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => {
      throw new Error('no debe haber red real');
    });
  });
  afterEach(() => fetchSpy.mockRestore());

  it('telegram: manda por TelegramService con chatRef, parse_mode HTML y sin botones; devuelve el message_id', async () => {
    const h = direct();

    const id = await h.internals.send('telegram', 'delivery_notice', {
      chatRef: 'delivery-group',
      text: '<b>hola</b>',
      parseMode: 'HTML',
      buttons: [{ label: 'Aceptar', action: 'x' }],
    });

    expect(h.telegram.send).toHaveBeenCalledWith({
      chatRef: 'delivery-group',
      text: '<b>hola</b>',
      parseMode: 'HTML',
      editMessageId: undefined,
    });
    expect(id).toBe('123');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('telegram: el message_id devuelto queda en notification_jobs.external_message_id', async () => {
    const h = setup();

    await h.service.notifyNow({
      channel: 'telegram',
      kind: 'delivery_notice',
      targetRef: 'order-1',
      payload: { chatRef: 'delivery-group', text: 'x' },
    });

    expect(h.state).toMatchObject({ status: 'sent', externalMessageId: '123' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('telegram: una respuesta ok:false deja el job en failed para reintento', async () => {
    const h = setup();
    h.telegram.send.mockResolvedValueOnce({ ok: false, error: 'http_error', status: 500 });

    await h.service.notifyNow({
      channel: 'telegram',
      kind: 'delivery_notice',
      targetRef: 'order-1',
      payload: { chatRef: 'delivery-group', text: 'x' },
    });

    expect(h.state).toMatchObject({ status: 'failed', claimToken: null, due: false });
  });

  it('whatsapp texto: resuelve el teléfono del cliente y manda por Kapso', async () => {
    const h = direct();

    const id = await h.internals.send('whatsapp', 'payment_decision', {
      customerId: 'customer-1',
      text: 'ok',
    });

    expect(h.internals.customerPhone).toHaveBeenCalledWith('customer-1');
    expect(h.kapso.sendText).toHaveBeenCalledWith('59170000000', 'ok');
    expect(id).toBe('wamid-1');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('location_request: pide la ubicación directo por Kapso', async () => {
    const h = direct();

    const id = await h.internals.send('whatsapp', 'location_request', { customerId: 'customer-1' });

    expect(h.kapso.sendLocationRequest).toHaveBeenCalledWith('59170000000');
    expect(h.kapso.sendText).not.toHaveBeenCalled();
    expect(id).toBe('wamid-loc');
  });

  it('whatsapp con imagen (QR): sube los bytes a Kapso y manda por media id con el texto de pie', async () => {
    const h = direct();
    jest
      .spyOn(h.internals, 'loadImage')
      .mockResolvedValue({ bytes: Buffer.from('png'), mimeType: 'image/png' });

    const id = await h.internals.send('whatsapp', 'qr_confirmation', {
      customerId: 'customer-1',
      text: 'Escaneá el QR',
      imageUrl: '/orders/00000000-0000-0000-0000-000000000001/qr-image',
    });

    expect(h.kapso.uploadImage).toHaveBeenCalledWith(Buffer.from('png'), 'image/png');
    expect(h.kapso.sendImageByMediaId).toHaveBeenCalledWith(
      '59170000000',
      'media-1',
      'Escaneá el QR',
    );
    expect(id).toBe('wamid-img');
  });

  it('whatsapp: un fallo de Kapso lanza (el job se reintenta) sin filtrar el teléfono', async () => {
    const h = direct();
    h.kapso.sendText.mockResolvedValueOnce({ ok: false, error: 'http_error', status: 502 });

    await expect(
      h.internals.send('whatsapp', 'payment_decision', { customerId: 'c', text: 'ok' }),
    ).rejects.toThrow('kapso_http_error_502');
  });

  it('whatsapp con una imageUrl que no es el QR interno se rechaza', async () => {
    const h = direct();

    await expect(
      h.internals.send('whatsapp', 'x', { customerId: 'c', text: 't', imageUrl: '/otra/ruta.png' }),
    ).rejects.toThrow('unsupported_image_url');
    expect(h.kapso.uploadImage).not.toHaveBeenCalled();
  });
});

describe('NotificationsOutService dedupe de delivery_notice (kind + target_ref)', () => {
  it('encolar dos veces el mismo delivery_notice usa ON CONFLICT (kind, target_ref) DO NOTHING y reutiliza la fila existente', async () => {
    const statements: string[] = [];
    let insertCount = 0;
    const client = {
      query: async (sqlText: string) => {
        const text = sqlText.replace(/\s+/g, ' ').trim().toLowerCase();
        statements.push(text);
        if (text.startsWith('insert into "notification_jobs"')) {
          insertCount += 1;
          // la 1ª inserta; la 2ª choca con el UNIQUE y no devuelve fila
          return insertCount === 1
            ? { command: 'INSERT', rowCount: 1, rows: [{ id: 'job-1' }] }
            : { command: 'INSERT', rowCount: 0, rows: [] };
        }
        if (text.startsWith('select "id" from "notification_jobs"')) {
          return { command: 'SELECT', rowCount: 1, rows: [{ id: 'job-1' }] };
        }
        throw new Error(`Unexpected SQL: ${text}`);
      },
      release: () => undefined,
    };
    const db = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: { connect: async () => client, end: async () => undefined } as never,
      }),
    });
    const service = new NotificationsOutService(db, {} as never, {} as never);
    const enqueue = (service as unknown as { enqueue(job: unknown): Promise<string> }).enqueue.bind(
      service,
    );
    const job = {
      channel: 'telegram',
      kind: 'delivery_notice',
      targetRef: 'order-uuid',
      payload: { chatRef: 'delivery-group', text: 'x' },
    };

    const first = await enqueue(job);
    const second = await enqueue(job);

    expect(first).toBe('job-1');
    expect(second).toBe('job-1');
    expect(statements.filter((t) => t.startsWith('insert'))).toHaveLength(2);
    expect(statements[0]).toContain('on conflict ("kind", "target_ref") do nothing');
  });
});

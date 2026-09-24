import { MenuDispatchService } from './menu-dispatch.service';
import { generateMenuSessionToken, hashMenuSessionToken } from './menu-session-token';

function fakeConfig() {
  const values: Record<string, unknown> = {
    menu: {
      sessionSecret: 'test-secret',
      webBaseUrl: 'https://menu.example.com',
      coverImageUrl: 'https://cdn.example.com/cover.jpg',
    },
  };
  return { get: (key: string) => values[key] };
}

function fakeSessions(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    findValidByPhone: jest.fn().mockResolvedValue(null),
    getOrCreate: jest.fn().mockImplementation(async (input) => ({
      id: 'session-1',
      sourceMessageId: input.sourceMessageId,
      tokenHash: input.tokenHash,
      customerPhone: input.customerPhone,
      phoneNumberId: input.phoneNumberId,
      expiresAt: '2026-01-01T02:00:00.000Z',
      replacesOrderId: input.replacesOrderId,
    })),
    renewExpiry: jest.fn().mockResolvedValue('2026-01-01T04:00:00.000Z'),
    ...overrides,
  };
}

function fakeDeliveries(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    claim: jest.fn().mockResolvedValue({ claimed: true, id: 'delivery-1' }),
    finish: jest.fn().mockResolvedValue(undefined),
    lastSentAt: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function fakeKapso(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    sendMenuCtaUrl: jest.fn().mockResolvedValue({ ok: true, wamid: 'wamid.cta.1' }),
    ...overrides,
  };
}

function buildService(
  config: unknown,
  sessions: unknown,
  deliveries: unknown,
  kapso: unknown,
): MenuDispatchService {
  return new MenuDispatchService(
    config as never,
    sessions as never,
    deliveries as never,
    kapso as never,
  );
}

const baseInput = {
  customerPhone: '59170000000',
  sourceMessageId: 'wamid.trigger.1',
  phoneNumberId: 'phone-1',
  reason: 'explicit_request' as const,
};

describe('MenuDispatchService', () => {
  it('crea una menu_session nueva y manda el CTA por Kapso (fake)', async () => {
    const sessions = fakeSessions();
    const deliveries = fakeDeliveries();
    const kapso = fakeKapso();
    const service = buildService(fakeConfig(), sessions, deliveries, kapso);

    const result = await service.dispatch(baseInput);

    expect(result).toEqual({ result: 'sent' });
    expect(sessions.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMessageId: 'wamid.trigger.1',
        customerPhone: '59170000000',
        phoneNumberId: 'phone-1',
        replacesOrderId: null,
      }),
    );
    expect(kapso.sendMenuCtaUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        customerPhone: '59170000000',
        menuUrl: expect.stringContaining('https://menu.example.com/menu?session='),
      }),
    );
    expect(deliveries.finish).toHaveBeenCalledWith({
      id: 'delivery-1',
      status: 'sent',
      providerMessageId: 'wamid.cta.1',
    });
  });

  it('reutiliza una sesión vigente para el mismo teléfono en vez de crear otra', async () => {
    const secret = 'test-secret';
    const originalToken = generateMenuSessionToken('wamid.original', secret);
    const sessions = fakeSessions({
      findValidByPhone: jest.fn().mockResolvedValue({
        id: 'session-existing',
        sourceMessageId: 'wamid.original',
        tokenHash: hashMenuSessionToken(originalToken),
        customerPhone: '59170000000',
        phoneNumberId: 'phone-1',
        expiresAt: '2026-01-01T03:00:00.000Z',
        replacesOrderId: null,
      }),
    });
    const deliveries = fakeDeliveries();
    const kapso = fakeKapso();
    const service = buildService(fakeConfig(), sessions, deliveries, kapso);

    await service.dispatch(baseInput);

    expect(sessions.getOrCreate).not.toHaveBeenCalled();
    expect(sessions.renewExpiry).toHaveBeenCalledWith('session-existing');
    const menuUrl = kapso.sendMenuCtaUrl.mock.calls[0][0].menuUrl as string;
    expect(menuUrl).toContain(encodeURIComponent(originalToken));
  });

  it('un enlace de reemplazo (replacesOrderId) nunca reutiliza una sesión existente', async () => {
    const findValidByPhone = jest.fn().mockResolvedValue({ id: 'session-existing' });
    const sessions = fakeSessions({ findValidByPhone });
    const service = buildService(fakeConfig(), sessions, fakeDeliveries(), fakeKapso());

    await service.dispatch({ ...baseInput, replacesOrderId: 'order-1' });

    expect(findValidByPhone).not.toHaveBeenCalled();
    expect(sessions.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ replacesOrderId: 'order-1' }),
    );
  });

  it('idempotencia técnica: un WAMID ya reclamado no vuelve a mandar el CTA (duplicate)', async () => {
    const deliveries = fakeDeliveries({ claim: jest.fn().mockResolvedValue({ claimed: false }) });
    const kapso = fakeKapso();
    const service = buildService(fakeConfig(), fakeSessions(), deliveries, kapso);

    const result = await service.dispatch(baseInput);

    expect(result).toEqual({ result: 'duplicate' });
    expect(kapso.sendMenuCtaUrl).not.toHaveBeenCalled();
  });

  it('ventana de eco: un CTA reciente (< 30s) bloquea el reenvío sin llamar a Kapso', async () => {
    const deliveries = fakeDeliveries({
      lastSentAt: jest.fn().mockResolvedValue(new Date(Date.now() - 5_000).toISOString()),
    });
    const kapso = fakeKapso();
    const service = buildService(fakeConfig(), fakeSessions(), deliveries, kapso);

    const result = await service.dispatch(baseInput);

    expect(result).toEqual({ result: 'echo' });
    expect(kapso.sendMenuCtaUrl).not.toHaveBeenCalled();
    expect(deliveries.finish).toHaveBeenCalledWith({ id: 'delivery-1', status: 'blocked_recent' });
  });

  it('un envío fuera de la ventana de eco (> 30s) sí manda el CTA', async () => {
    const deliveries = fakeDeliveries({
      lastSentAt: jest.fn().mockResolvedValue(new Date(Date.now() - 60_000).toISOString()),
    });
    const kapso = fakeKapso();
    const service = buildService(fakeConfig(), fakeSessions(), deliveries, kapso);

    const result = await service.dispatch(baseInput);

    expect(result).toEqual({ result: 'sent' });
    expect(kapso.sendMenuCtaUrl).toHaveBeenCalledTimes(1);
  });

  it('un fallo determinista de Kapso (invalid_phone) cierra el ledger como failed', async () => {
    const deliveries = fakeDeliveries();
    const kapso = fakeKapso({
      sendMenuCtaUrl: jest.fn().mockResolvedValue({ ok: false, error: 'invalid_phone' }),
    });
    const service = buildService(fakeConfig(), fakeSessions(), deliveries, kapso);

    const result = await service.dispatch(baseInput);

    expect(result).toEqual({ result: 'failed' });
    expect(deliveries.finish).toHaveBeenCalledWith({
      id: 'delivery-1',
      status: 'failed',
      errorCode: 'send.invalid_phone',
    });
  });

  it('un fallo sin certeza (timeout) cierra el ledger como send_unknown, nunca se reintenta a ciegas', async () => {
    const deliveries = fakeDeliveries();
    const kapso = fakeKapso({
      sendMenuCtaUrl: jest.fn().mockResolvedValue({ ok: false, error: 'timeout' }),
    });
    const service = buildService(fakeConfig(), fakeSessions(), deliveries, kapso);

    const result = await service.dispatch(baseInput);

    expect(result).toEqual({ result: 'send_unknown' });
  });

  it('sin MENU_SESSION_SECRET configurado, falla sin reclamar ningún envío', async () => {
    const config = { get: () => ({ sessionSecret: '', webBaseUrl: '', coverImageUrl: '' }) };
    const deliveries = fakeDeliveries();
    const service = buildService(config, fakeSessions(), deliveries, fakeKapso());

    const result = await service.dispatch(baseInput);

    expect(result).toEqual({ result: 'failed' });
    expect(deliveries.claim).not.toHaveBeenCalled();
  });
});

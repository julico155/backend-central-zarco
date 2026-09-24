import { buildHandoffNotice } from './handoff-notice';
import { HandoffNoticeService } from './handoff-notice.service';
import { createHandoffPort, createSilenceAfterSpokenHandoff } from './handoff.service';

describe('buildHandoffNotice — texto de sarcoRestaurant', () => {
  it('con último mensaje', () => {
    expect(
      buildHandoffNotice({
        customerPhone: '59170000000',
        reason: 'handoff_requested',
        lastMessage: 'quiero hablar con alguien',
      }),
    ).toBe(
      [
        '🙋 Atención humana — Don Zarco',
        '',
        'Motivo: El cliente necesita hablar con una persona',
        'Teléfono: 59170000000',
        'Abrir chat: https://wa.me/59170000000',
        '',
        'Último mensaje:',
        '"quiero hablar con alguien"',
        '',
        'El agente quedó en pausa. Responde desde WhatsApp Business App.',
      ].join('\n'),
    );
  });

  it('sin mensaje no escribe el bloque; motivo desconocido → genérico; sin escapar HTML', () => {
    const text = buildHandoffNotice({
      customerPhone: '5917',
      reason: 'algo_nuevo',
      lastMessage: '   ',
    });
    expect(text).toContain('Motivo: La conversación necesita a una persona');
    expect(text).not.toContain('Último mensaje');

    expect(
      buildHandoffNotice({
        customerPhone: '5917',
        reason: 'handoff_spoken',
        lastMessage: 'a<b>&c',
      }),
    ).toContain('"a<b>&c"');
  });

  it('recorta el mensaje a 200 caracteres con …', () => {
    const text = buildHandoffNotice({
      customerPhone: '5917',
      reason: 'handoff_requested',
      lastMessage: 'x'.repeat(300),
    });
    expect(text).toContain(`"${'x'.repeat(200)}…"`);
  });
});

describe('HandoffNoticeService', () => {
  it('encola handoff_notice por telegram al chat de atención humana (handoff-group), por teléfono, en texto plano', async () => {
    const notifications = { notifyNow: jest.fn().mockResolvedValue(undefined) };
    const service = new HandoffNoticeService(notifications as never);

    await service.notify({
      customerPhone: '59170000000',
      reason: 'handoff_requested',
      lastMessage: 'hola',
    });

    const job = notifications.notifyNow.mock.calls[0][0];
    expect(job).toMatchObject({
      channel: 'telegram',
      kind: 'handoff_notice',
      targetRef: '59170000000',
      payload: { chatRef: 'handoff-group' },
    });
    expect(job.payload).not.toHaveProperty('parseMode');
    expect(job.payload.chatRef).not.toBe('delivery-group');
  });

  it('nunca lanza aunque falle la cola', async () => {
    const notifications = { notifyNow: jest.fn().mockRejectedValue(new Error('down')) };
    const service = new HandoffNoticeService(notifications as never);
    await expect(
      service.notify({ customerPhone: '5917', reason: 'handoff_requested', lastMessage: null }),
    ).resolves.toBeUndefined();
  });
});

describe('puertos de handoff → aviso', () => {
  // Pausa real contra un store falso mínimo.
  function fakeStore() {
    return {
      pauseAgent: jest.fn().mockResolvedValue({ result: 'ok', pause: 'applied' }),
    } as never;
  }
  let pauseSpy: jest.SpyInstance;

  beforeEach(async () => {
    const mod = await import('../control/handoff-pause');
    pauseSpy = jest.spyOn(mod, 'pauseAgentForHandoff');
  });
  afterEach(() => pauseSpy.mockRestore());

  it('escalate avisa con motivo handoff_requested y el mensaje del cliente', async () => {
    pauseSpy.mockResolvedValue({ result: 'ok', pause: 'applied' });
    const notify = jest.fn().mockResolvedValue(undefined);

    const out = await createHandoffPort(fakeStore(), notify).escalate({
      customerPhone: '59170000000',
      sourceMessageId: 'wamid.1',
      inboundText: 'quiero hablar con una persona',
    });

    expect(out).toEqual({ handed: true });
    expect(notify).toHaveBeenCalledWith({
      customerPhone: '59170000000',
      reason: 'handoff_requested',
      lastMessage: 'quiero hablar con una persona',
    });
  });

  it('escalate NO avisa si la pausa ya estaba aplicada (mismo criterio que sarcoRestaurant)', async () => {
    pauseSpy.mockResolvedValue({ result: 'ok', pause: 'already_applied' });
    const notify = jest.fn();

    await createHandoffPort(fakeStore(), notify).escalate({
      customerPhone: '59170000000',
      sourceMessageId: 'wamid.1',
      inboundText: 'quiero hablar con una persona',
    });

    expect(notify).not.toHaveBeenCalled();
  });

  it('escalate sin motivo (sin pausa) no avisa', async () => {
    const notify = jest.fn();
    const out = await createHandoffPort(fakeStore(), notify).escalate({
      customerPhone: '59170000000',
      sourceMessageId: 'wamid.1',
      inboundText: 'hola, buenas',
    });
    expect(out).toEqual({ handed: false });
    expect(notify).not.toHaveBeenCalled();
  });

  it('handoff dicho por el agente avisa con handoff_spoken', async () => {
    pauseSpy.mockResolvedValue({ result: 'ok', pause: 'applied' });
    const notify = jest.fn().mockResolvedValue(undefined);

    await createSilenceAfterSpokenHandoff(
      fakeStore(),
      notify,
    )({
      customerPhone: '59170000000',
      sourceMessageId: 'wamid.2',
      inboundText: 'no me entienden',
    });

    expect(notify).toHaveBeenCalledWith({
      customerPhone: '59170000000',
      reason: 'handoff_spoken',
      lastMessage: 'no me entienden',
    });
  });
});

import { SarcoAgentService } from './sarco-agent.service';
import type { NormalizedKapsoEvent } from '../kapso/kapso.types';

function fakeConfig(agent: Partial<Record<string, string>> = {}) {
  const values: Record<string, unknown> = {
    agent: {
      enabled: 'false', // deshabilitado por defecto: runAgentTurn corta antes de tocar la base salvo resolveExpiredPause.
      accessMode: '',
      testPhones: '',
      apiKey: '',
      model: '',
      visionModel: '',
      humanTakeoverPauseMinutes: '',
      ...agent,
    },
  };
  return { get: (key: string) => values[key] } as never;
}

function fakeRepository() {
  const conversations = new Map<string, { id: string; state: 'active' | 'paused' }>();
  const insertMessage = jest.fn().mockResolvedValue('inserted');
  const findPauseStateByPhone = jest.fn(async (phone: string) => {
    const conv = conversations.get(phone);
    if (!conv) return null;
    return {
      conversationId: conv.id,
      state: conv.state,
      pausedAt: null,
      pauseExpiresAt: null,
      pauseReason: null,
      pauseSource: null,
      resumedAt: null,
    };
  });
  const upsertConversation = jest.fn(async (input: { customerPhone: string }) => {
    const existing = conversations.get(input.customerPhone);
    if (existing) return existing;
    const conv = { id: `conv-${input.customerPhone}`, state: 'active' as const };
    conversations.set(input.customerPhone, conv);
    return conv;
  });
  const pauseConversation = jest.fn().mockResolvedValue('paused');
  const insertControlEvent = jest.fn().mockResolvedValue('inserted');
  const hasPauseEventForMessage = jest.fn().mockResolvedValue(false);

  return {
    conversations,
    insertMessage,
    findPauseStateByPhone,
    upsertConversation,
    pauseConversation,
    insertControlEvent,
    hasPauseEventForMessage,
    touchCustomerMessageAt: jest.fn(),
    touchHumanMessageAt: jest.fn(),
    renewPause: jest.fn().mockResolvedValue('renewed'),
    resumeConversation: jest.fn().mockResolvedValue('resumed'),
    hasResumeEvent: jest.fn().mockResolvedValue(false),
    claimRun: jest.fn(),
    markRunSending: jest.fn(),
    finishRun: jest.fn(),
    loadRecentMessages: jest.fn().mockResolvedValue([]),
    findMessageIdByProviderMessageId: jest.fn().mockResolvedValue(null),
    touchAiMessageAt: jest.fn(),
  };
}

function baseEvent(overrides: Partial<NormalizedKapsoEvent> = {}): NormalizedKapsoEvent {
  return {
    eventName: 'whatsapp.message.received',
    eventId: 'event-1',
    envelopeIndex: 0,
    messageId: 'wamid.1',
    customerPhone: '59170000000',
    conversationId: null,
    phoneNumberId: 'phone-1',
    contentType: 'text',
    text: 'hola',
    image: null,
    audio: null,
    location: null,
    interactive: null,
    ...overrides,
  };
}

describe('SarcoAgentService.handleInboundBatch', () => {
  it('persiste TODOS los mensajes del lote, elegibles o no', async () => {
    const repository = fakeRepository();
    const service = new SarcoAgentService(
      fakeConfig(),
      repository as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.handleInboundBatch([
      baseEvent({ messageId: 'wamid.1', contentType: 'text', text: 'hola' }),
      baseEvent({ messageId: 'wamid.2', contentType: 'location', text: null }),
    ]);

    expect(repository.insertMessage).toHaveBeenCalledTimes(2);
  });

  it('un mensaje no elegible (ubicación) NO dispara un turno del agente', async () => {
    const repository = fakeRepository();
    const service = new SarcoAgentService(
      fakeConfig(),
      repository as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.handleInboundBatch([baseEvent({ contentType: 'location', text: null })]);

    // resolveExpiredPause (dentro de runTurn) es lo único que llamaría a
    // findPauseStateByPhone además de persistCustomerInbound — y
    // persistCustomerInbound no lo llama. Si el turno no arrancó, esta
    // función nunca se invoca.
    expect(repository.findPauseStateByPhone).not.toHaveBeenCalled();
  });

  it('un mensaje elegible SÍ intenta un turno (aunque el agente esté deshabilitado)', async () => {
    const repository = fakeRepository();
    const service = new SarcoAgentService(
      fakeConfig(),
      repository as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.handleInboundBatch([baseEvent({ contentType: 'text', text: 'hola' })]);

    // resolveExpiredPause SÍ corre (best-effort) antes de runAgentTurn.
    expect(repository.findPauseStateByPhone).toHaveBeenCalledWith('59170000000');
  });
});

describe('SarcoAgentService.handleOutboundEvent', () => {
  it('whatsapp.message.sent con origin business_app dispara el takeover humano (pausa la conversación)', async () => {
    const repository = fakeRepository();
    repository.conversations.set('59170000000', { id: 'conv-1', state: 'active' });
    const service = new SarcoAgentService(
      fakeConfig(),
      repository as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const payload = {
      message: {
        id: 'wamid.human',
        to: '59170000000',
        kapso: { direction: 'outbound', origin: 'business_app' },
      },
    };
    await service.handleOutboundEvent('whatsapp.message.sent', payload, [
      baseEvent({ eventName: 'whatsapp.message.sent', messageId: 'wamid.human' }),
    ]);

    expect(repository.pauseConversation).toHaveBeenCalledTimes(1);
  });

  it('whatsapp.message.sent con origin cloud_api (envío nuestro) NO dispara takeover', async () => {
    const repository = fakeRepository();
    const service = new SarcoAgentService(
      fakeConfig(),
      repository as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const payload = {
      message: { id: 'wamid.ours', kapso: { direction: 'outbound', origin: 'cloud_api' } },
    };
    await service.handleOutboundEvent('whatsapp.message.sent', payload, [
      baseEvent({ eventName: 'whatsapp.message.sent' }),
    ]);

    expect(repository.pauseConversation).not.toHaveBeenCalled();
  });

  it('delivered/read/failed quedan diferidos, sin ejecutar nada', async () => {
    const repository = fakeRepository();
    const service = new SarcoAgentService(
      fakeConfig(),
      repository as never,
      {} as never,
      {} as never,
      {} as never,
    );

    for (const eventName of [
      'whatsapp.message.delivered',
      'whatsapp.message.read',
      'whatsapp.message.failed',
    ]) {
      await service.handleOutboundEvent(eventName, {}, [baseEvent({ eventName })]);
    }

    expect(repository.pauseConversation).not.toHaveBeenCalled();
    expect(repository.upsertConversation).not.toHaveBeenCalled();
  });
});

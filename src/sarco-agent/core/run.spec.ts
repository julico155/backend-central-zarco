import { runAgentTurn } from './run';
import type { AgentModel } from './model';
import type {
  AgentConversationRef,
  AgentInboundMessage,
  AgentPauseState,
  AgentRunStore,
  AgentSendPort,
  AgentSendResult,
  AgentStore,
  ClaimAgentRunInput,
  ClaimAgentRunResult,
  FinishAgentRunInput,
  InsertAgentMessageInput,
} from './types';
import type { AgentTool } from '../tools/registry';
import { NO_ARGUMENTS } from '../tools/registry';

/**
 * Ejecución del turno completo con fakes en memoria — nunca toca una base ni
 * hace una llamada de red real: `AgentModel.complete` y `AgentSendPort.sendText`
 * son jest.fn() inyectados por cada test.
 */

function makeMessage(overrides: Partial<AgentInboundMessage> = {}): AgentInboundMessage {
  return {
    providerMessageId: 'wamid.1',
    providerConversationId: 'conv-provider-1',
    customerPhone: '59170000000',
    providerPhoneNumberId: 'phone-1',
    messageTimestamp: '2026-01-01T12:00:00.000Z',
    content: 'hola',
    contentType: 'text',
    metadata: null,
    image: null,
    ...overrides,
  };
}

interface FakeConversation {
  id: string;
  state: 'active' | 'paused';
  pausedAt: string | null;
  pauseExpiresAt: string | null;
  pauseReason: string | null;
  pauseSource: string | null;
  resumedAt: string | null;
}

class FakeStore implements AgentStore, AgentRunStore {
  conversations = new Map<string, FakeConversation>();
  messages: InsertAgentMessageInput[] = [];
  runs = new Map<string, { id: string; status: string }>();
  finishedRuns: FinishAgentRunInput[] = [];
  private seq = 0;

  seedConversation(phone: string, overrides: Partial<FakeConversation> = {}): FakeConversation {
    const conv: FakeConversation = {
      id: `conv-${phone}`,
      state: 'active',
      pausedAt: null,
      pauseExpiresAt: null,
      pauseReason: null,
      pauseSource: null,
      resumedAt: null,
      ...overrides,
    };
    this.conversations.set(phone, conv);
    return conv;
  }

  async upsertConversation(input: { customerPhone: string }): Promise<AgentConversationRef> {
    const existing = this.conversations.get(input.customerPhone);
    if (existing) return { id: existing.id, state: existing.state };
    const conv = this.seedConversation(input.customerPhone);
    return { id: conv.id, state: conv.state };
  }

  async insertMessage(input: InsertAgentMessageInput) {
    if (
      this.messages.some(
        (m) => m.providerMessageId !== null && m.providerMessageId === input.providerMessageId,
      )
    ) {
      return 'duplicate' as const;
    }
    this.messages.push(input);
    return 'inserted' as const;
  }

  async touchCustomerMessageAt() {}
  async touchHumanMessageAt() {}
  async pauseConversation() {
    return 'paused' as const;
  }
  async renewPause() {
    return 'renewed' as const;
  }
  async resumeConversation() {
    return 'resumed' as const;
  }
  async insertControlEvent() {
    return 'inserted' as const;
  }
  async hasResumeEvent() {
    return false;
  }
  async hasPauseEventForMessage() {
    return false;
  }

  async findPauseStateByPhone(customerPhone: string): Promise<AgentPauseState | null> {
    const conv = this.conversations.get(customerPhone);
    if (!conv) return null;
    return {
      conversationId: conv.id,
      state: conv.state,
      pausedAt: conv.pausedAt,
      pauseExpiresAt: conv.pauseExpiresAt,
      pauseReason: conv.pauseReason,
      pauseSource: conv.pauseSource,
      resumedAt: conv.resumedAt,
    };
  }

  async claimRun(input: ClaimAgentRunInput): Promise<ClaimAgentRunResult> {
    const existing = this.runs.get(input.sourceMessageId);
    if (existing) return { result: 'exists', runId: existing.id, status: existing.status as never };
    const id = `run-${++this.seq}`;
    this.runs.set(input.sourceMessageId, { id, status: 'processing' });
    return { result: 'claimed', runId: id };
  }

  async markRunSending() {}

  async finishRun(input: FinishAgentRunInput) {
    this.finishedRuns.push(input);
    for (const [key, run] of this.runs) {
      if (run.id === input.runId) this.runs.set(key, { ...run, status: input.status });
    }
  }

  async loadRecentMessages() {
    return [];
  }
  async findMessageIdByProviderMessageId() {
    return null;
  }
  async touchAiMessageAt() {}
}

function fakeModel(complete: jest.Mock): AgentModel {
  return { model: 'gpt-4o-mini', complete: complete as unknown as AgentModel['complete'] };
}

function fakeSend(
  overrides: Partial<AgentSendResult> = { ok: true, wamid: 'wamid.out' },
): AgentSendPort {
  return {
    sendText: jest.fn().mockResolvedValue(overrides),
  };
}

const eligibleConfig = {
  enabled: true,
  accessMode: 'all' as const,
  testPhones: [],
  hasApiKey: true,
};

describe('runAgentTurn', () => {
  it('no llama a OpenAI ni a la base cuando el agente está deshabilitado', async () => {
    const store = new FakeStore();
    const complete = jest.fn();
    const result = await runAgentTurn(makeMessage(), {
      store,
      runs: store,
      model: fakeModel(complete),
      send: fakeSend(),
      config: { ...eligibleConfig, enabled: false },
      systemPrompt: 'prompt',
    });

    expect(result).toEqual({ result: 'skipped', reason: 'disabled' });
    expect(complete).not.toHaveBeenCalled();
    expect(store.runs.size).toBe(0);
  });

  it('rechaza un teléfono que no está en la allowlist', async () => {
    const store = new FakeStore();
    const complete = jest.fn();
    const result = await runAgentTurn(makeMessage({ customerPhone: '59171111111' }), {
      store,
      runs: store,
      model: fakeModel(complete),
      send: fakeSend(),
      config: { ...eligibleConfig, accessMode: 'allowlist', testPhones: ['59170000000'] },
      systemPrompt: 'prompt',
    });

    expect(result).toEqual({ result: 'skipped', reason: 'phone_not_allowed' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('un mensaje no elegible (sin texto ni imagen) no llama a OpenAI', async () => {
    const store = new FakeStore();
    store.seedConversation('59170000000');
    const complete = jest.fn();
    const result = await runAgentTurn(makeMessage({ contentType: 'location', content: null }), {
      store,
      runs: store,
      model: fakeModel(complete),
      send: fakeSend(),
      config: eligibleConfig,
      systemPrompt: 'prompt',
    });

    expect(result).toEqual({ result: 'skipped', reason: 'unsupported_content' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('sin conversación existente, el turno no arranca (la crea la persistencia previa)', async () => {
    const store = new FakeStore();
    const complete = jest.fn();
    const result = await runAgentTurn(makeMessage(), {
      store,
      runs: store,
      model: fakeModel(complete),
      send: fakeSend(),
      config: eligibleConfig,
      systemPrompt: 'prompt',
    });

    expect(result).toEqual({ result: 'skipped', reason: 'no_conversation' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('una conversación pausada termina el run como skipped_paused sin llamar a OpenAI', async () => {
    const store = new FakeStore();
    store.seedConversation('59170000000', {
      state: 'paused',
      pausedAt: '2026-01-01T00:00:00.000Z',
      pauseExpiresAt: null,
      pauseReason: 'human_whatsapp_business_app',
      pauseSource: 'business_app',
    });
    const complete = jest.fn();
    const result = await runAgentTurn(makeMessage(), {
      store,
      runs: store,
      model: fakeModel(complete),
      send: fakeSend(),
      config: eligibleConfig,
      systemPrompt: 'prompt',
    });

    expect(result).toEqual({ result: 'skipped', reason: 'paused', runId: expect.any(String) });
    expect(complete).not.toHaveBeenCalled();
    expect(store.finishedRuns[0]).toMatchObject({
      status: 'skipped_paused',
      skippedAtBarrier: 'pre_openai',
    });
  });

  it('ejecuta OpenAI (mock), envía y persiste la respuesta, y cierra el run como completed', async () => {
    const store = new FakeStore();
    store.seedConversation('59170000000');
    const complete = jest
      .fn()
      .mockResolvedValue({ ok: true, text: 'Hola! En qué te ayudo?', model: 'gpt-4o-mini' });
    const send = fakeSend({ ok: true, wamid: 'wamid.out.1' });

    const result = await runAgentTurn(makeMessage(), {
      store,
      runs: store,
      model: fakeModel(complete),
      send,
      config: eligibleConfig,
      systemPrompt: 'prompt',
    });

    expect(result).toEqual({ result: 'replied', runId: expect.any(String) });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(send.sendText).toHaveBeenCalledWith('59170000000', 'Hola! En qué te ayudo?', 'phone-1');
    expect(store.messages).toContainEqual(
      expect.objectContaining({
        actor: 'ai',
        direction: 'outbound',
        content: 'Hola! En qué te ayudo?',
      }),
    );
    expect(store.finishedRuns[0]).toMatchObject({ status: 'completed' });
  });

  it('una segunda entrega del mismo WAMID no vuelve a llamar a OpenAI (duplicate)', async () => {
    const store = new FakeStore();
    store.seedConversation('59170000000');
    const complete = jest.fn().mockResolvedValue({ ok: true, text: 'listo', model: 'gpt-4o-mini' });
    const deps = {
      store,
      runs: store,
      model: fakeModel(complete),
      send: fakeSend(),
      config: eligibleConfig,
      systemPrompt: 'prompt',
    };

    const first = await runAgentTurn(makeMessage(), deps);
    expect(first.result).toBe('replied');
    expect(complete).toHaveBeenCalledTimes(1);

    const second = await runAgentTurn(makeMessage(), deps);
    expect(second).toEqual({
      result: 'duplicate',
      runId: first.result === 'replied' ? first.runId : undefined,
      status: 'completed',
    });
    // Ninguna llamada adicional al modelo.
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('un fallo del modelo cierra el run como failed y NO envía ni persiste nada', async () => {
    const store = new FakeStore();
    store.seedConversation('59170000000');
    const complete = jest.fn().mockResolvedValue({ ok: false, error: 'http_error', status: 500 });
    const send = fakeSend();

    const result = await runAgentTurn(makeMessage(), {
      store,
      runs: store,
      model: fakeModel(complete),
      send,
      config: eligibleConfig,
      systemPrompt: 'prompt',
    });

    expect(result).toEqual({
      result: 'failed',
      runId: expect.any(String),
      error: 'model.http_error.500',
    });
    expect(send.sendText).not.toHaveBeenCalled();
    expect(store.messages).toHaveLength(0);
    expect(store.finishedRuns[0]).toMatchObject({
      status: 'failed',
      errorCode: 'model.http_error.500',
    });

    // El estado queda TERMINAL, no corrupto: una reentrega del mismo WAMID
    // encuentra el run ya 'failed' y no reintenta a ciegas.
    const retry = await runAgentTurn(makeMessage(), {
      store,
      runs: store,
      model: fakeModel(complete),
      send,
      config: eligibleConfig,
      systemPrompt: 'prompt',
    });
    expect(retry).toEqual({ result: 'duplicate', runId: result.runId, status: 'failed' });
  });

  it('con una acción directa (answer_directly-like), el modelo redacta sin ejecutar nada', async () => {
    const store = new FakeStore();
    store.seedConversation('59170000000');
    const answerDirectly: AgentTool = {
      definition: { name: 'answer_directly', description: 'responde', parameters: NO_ARGUMENTS },
    };
    const complete = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: '',
        model: 'gpt-4o-mini',
        toolCalls: [{ callId: 'call-1', name: 'answer_directly', arguments: '{}' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        text: 'Atendemos de 19:00 a 04:00.',
        model: 'gpt-4o-mini',
      });
    const send = fakeSend({ ok: true, wamid: 'wamid.out.2' });

    const result = await runAgentTurn(makeMessage({ content: 'a q hora abren' }), {
      store,
      runs: store,
      model: fakeModel(complete),
      send,
      config: eligibleConfig,
      systemPrompt: 'prompt',
      actions: [answerDirectly],
    });

    expect(result.result).toBe('replied');
    expect(complete).toHaveBeenCalledTimes(2);
    expect(send.sendText).toHaveBeenCalledWith(
      '59170000000',
      'Atendemos de 19:00 a 04:00.',
      'phone-1',
    );
  });

  it('request_human pausa la conversación y el turno cierra en silencio, sin ronda de redacción', async () => {
    const store = new FakeStore();
    store.seedConversation('59170000000');
    const escalate = jest.fn().mockResolvedValue({ handed: true });
    const requestHuman: AgentTool = {
      definition: { name: 'request_human', description: 'deriva', parameters: NO_ARGUMENTS },
      producesUserVisibleEffect: true,
      effectCompletesTurn: true,
      async execute() {
        const { handed } = await escalate();
        return {
          result: { handed },
          userVisibleEffectConfirmed: handed,
          silenceAfterReply: !handed,
        };
      },
    };
    const complete = jest.fn().mockResolvedValue({
      ok: true,
      text: '',
      model: 'gpt-4o-mini',
      toolCalls: [{ callId: 'call-1', name: 'request_human', arguments: '{}' }],
    });
    const send = fakeSend();

    const result = await runAgentTurn(makeMessage({ content: 'quiero reclamar, esto es pésimo' }), {
      store,
      runs: store,
      model: fakeModel(complete),
      send,
      config: eligibleConfig,
      systemPrompt: 'prompt',
      actions: [requestHuman],
    });

    expect(result).toEqual({ result: 'completed_silent', runId: expect.any(String) });
    expect(escalate).toHaveBeenCalledTimes(1);
    // Solo la ronda de selección: el efecto YA es la respuesta, no hay redacción.
    expect(complete).toHaveBeenCalledTimes(1);
    expect(send.sendText).not.toHaveBeenCalled();
  });

  it('la pausa aparecida justo antes de enviar aborta el envío (barrera pre-send)', async () => {
    const store = new FakeStore();
    store.seedConversation('59170000000');
    const complete = jest.fn().mockImplementation(async () => {
      // Un humano toma el control MIENTRAS el modelo redactaba.
      store.conversations.set('59170000000', {
        ...store.conversations.get('59170000000')!,
        state: 'paused',
        pausedAt: '2026-01-01T12:00:00.000Z',
        pauseExpiresAt: null,
        pauseReason: 'human_whatsapp_business_app',
        pauseSource: 'business_app',
      });
      return { ok: true, text: 'hola', model: 'gpt-4o-mini' };
    });
    const send = fakeSend();

    const result = await runAgentTurn(makeMessage(), {
      store,
      runs: store,
      model: fakeModel(complete),
      send,
      config: eligibleConfig,
      systemPrompt: 'prompt',
    });

    expect(result).toEqual({ result: 'skipped', reason: 'paused', runId: expect.any(String) });
    expect(send.sendText).not.toHaveBeenCalled();
  });
});

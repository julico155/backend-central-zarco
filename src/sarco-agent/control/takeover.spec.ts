import { handleHumanTakeover, humanTakeoverPauseMinutes, pauseExpiryFrom } from './takeover';
import type { AgentInboundMessage, AgentStore } from '../core/types';

interface Row {
  id: string;
  state: 'active' | 'paused';
  pausedAt: string | null;
  pauseExpiresAt: string | null;
  pauseReason: string | null;
  pauseSource: string | null;
}

function makeStore() {
  const conversations = new Map<string, Row>();
  const messages: unknown[] = [];
  const controlEvents: unknown[] = [];
  const pauseEvents = new Set<string>(); // `${conversationId}:${wamid}`

  const store: AgentStore = {
    async upsertConversation(input) {
      const existing = conversations.get(input.customerPhone);
      if (existing) return { id: existing.id, state: existing.state };
      const row: Row = {
        id: `conv-${input.customerPhone}`,
        state: 'active',
        pausedAt: null,
        pauseExpiresAt: null,
        pauseReason: null,
        pauseSource: null,
      };
      conversations.set(input.customerPhone, row);
      return { id: row.id, state: row.state };
    },
    async insertMessage(input) {
      const key = input.providerMessageId;
      if (
        key !== null &&
        messages.some((m) => (m as { providerMessageId: string | null }).providerMessageId === key)
      ) {
        return 'duplicate';
      }
      messages.push(input);
      return 'inserted';
    },
    async touchCustomerMessageAt() {},
    async touchHumanMessageAt() {},
    async pauseConversation(input) {
      const row = [...conversations.values()].find((r) => r.id === input.agentConversationId)!;
      if (row.state === 'paused') return 'already_paused';
      row.state = 'paused';
      row.pausedAt = input.pausedAt;
      row.pauseExpiresAt = input.pauseExpiresAt;
      row.pauseReason = input.reason;
      row.pauseSource = input.source;
      return 'paused';
    },
    async renewPause(input) {
      const row = [...conversations.values()].find((r) => r.id === input.agentConversationId)!;
      if (
        row.state !== 'paused' ||
        row.pauseReason !== input.reason ||
        row.pauseSource !== input.source
      ) {
        return 'not_renewable';
      }
      row.pauseExpiresAt = input.pauseExpiresAt;
      return 'renewed';
    },
    async resumeConversation(input) {
      const row = [...conversations.values()].find((r) => r.id === input.agentConversationId)!;
      if (row.state !== 'paused') return 'already_active';
      row.state = 'active';
      row.pausedAt = null;
      row.pauseExpiresAt = null;
      row.pauseReason = null;
      row.pauseSource = null;
      return 'resumed';
    },
    async insertControlEvent(input) {
      controlEvents.push(input);
      return 'inserted';
    },
    async hasResumeEvent() {
      return false;
    },
    async hasPauseEventForMessage(conversationId, providerMessageId) {
      return pauseEvents.has(`${conversationId}:${providerMessageId}`);
    },
    async findPauseStateByPhone(customerPhone) {
      const row = conversations.get(customerPhone);
      if (!row) return null;
      return {
        conversationId: row.id,
        state: row.state,
        pausedAt: row.pausedAt,
        pauseExpiresAt: row.pauseExpiresAt,
        pauseReason: row.pauseReason,
        pauseSource: row.pauseSource,
        resumedAt: null,
      };
    },
  };

  return {
    store,
    conversations,
    messages,
    controlEvents,
    markPauseEventApplied: (id: string, wamid: string) => pauseEvents.add(`${id}:${wamid}`),
  };
}

function humanMessage(overrides: Partial<AgentInboundMessage> = {}): AgentInboundMessage {
  return {
    providerMessageId: 'wamid.human.1',
    providerConversationId: 'prov-conv-1',
    customerPhone: '59170000000',
    providerPhoneNumberId: 'phone-1',
    messageTimestamp: '2026-01-01T00:00:00.000Z',
    content: 'ya te atiendo',
    contentType: 'text',
    metadata: null,
    image: null,
    ...overrides,
  };
}

describe('humanTakeoverPauseMinutes', () => {
  it('usa el default ante un valor ausente o no numérico', () => {
    expect(humanTakeoverPauseMinutes(undefined)).toBe(30);
    expect(humanTakeoverPauseMinutes('treinta')).toBe(30);
    expect(humanTakeoverPauseMinutes('')).toBe(30);
  });

  it('usa el default fuera de rango, nunca recorta', () => {
    expect(humanTakeoverPauseMinutes('0')).toBe(30);
    expect(humanTakeoverPauseMinutes('99999')).toBe(30);
  });

  it('acepta un entero válido dentro del rango', () => {
    expect(humanTakeoverPauseMinutes('45')).toBe(45);
  });
});

describe('handleHumanTakeover', () => {
  it('pausa la conversación, persiste el mensaje humano y deja un evento de control', async () => {
    const { store, conversations, messages, controlEvents } = makeStore();

    const result = await handleHumanTakeover(
      humanMessage(),
      store,
      () => '2026-01-01T00:05:00.000Z',
      30,
    );

    expect(result.result).toBe('ok');
    if (result.result !== 'ok') throw new Error('unreachable');
    expect(result.message).toBe('inserted');
    expect(result.pause).toBe('paused');
    expect(result.controlEvent).toBe('inserted');

    const conv = conversations.get('59170000000')!;
    expect(conv.state).toBe('paused');
    expect(conv.pauseExpiresAt).toBe(pauseExpiryFrom('2026-01-01T00:00:00.000Z', 30));
    expect(messages).toHaveLength(1);
    expect(controlEvents).toHaveLength(1);
  });

  it('un WAMID humano que ya completó su takeover no vuelve a escribir nada (already_applied)', async () => {
    const { store, messages, controlEvents, markPauseEventApplied } = makeStore();
    // Primera pasada real.
    await handleHumanTakeover(humanMessage(), store, () => '2026-01-01T00:05:00.000Z', 30);
    markPauseEventApplied('conv-59170000000', 'wamid.human.1');

    const before = { messages: messages.length, controlEvents: controlEvents.length };
    const result = await handleHumanTakeover(
      humanMessage(),
      store,
      () => '2026-01-01T00:06:00.000Z',
      30,
    );

    expect(result).toEqual({
      result: 'ok',
      conversationId: 'conv-59170000000',
      message: 'duplicate',
      pause: 'already_applied',
      controlEvent: 'duplicate',
    });
    expect(messages.length).toBe(before.messages);
    expect(controlEvents.length).toBe(before.controlEvents);
  });

  it('sin teléfono o sin WAMID, se rechaza sin escribir nada', async () => {
    const { store, messages } = makeStore();
    const noPhone = await handleHumanTakeover(humanMessage({ customerPhone: '' }), store);
    const noWamid = await handleHumanTakeover(humanMessage({ providerMessageId: null }), store);

    expect(noPhone).toEqual({ result: 'rejected', reason: 'missing_phone' });
    expect(noWamid).toEqual({ result: 'rejected', reason: 'missing_message_id' });
    expect(messages).toHaveLength(0);
  });

  it('un segundo mensaje humano renueva el vencimiento de la pausa (no la reinicia por reentrega)', async () => {
    const { store, conversations } = makeStore();
    await handleHumanTakeover(humanMessage(), store, () => '2026-01-01T00:00:00.000Z', 30);

    await handleHumanTakeover(
      humanMessage({
        providerMessageId: 'wamid.human.2',
        messageTimestamp: '2026-01-01T00:10:00.000Z',
      }),
      store,
      () => '2026-01-01T00:10:00.000Z',
      30,
    );

    const conv = conversations.get('59170000000')!;
    expect(conv.pauseExpiresAt).toBe(pauseExpiryFrom('2026-01-01T00:10:00.000Z', 30));
  });
});

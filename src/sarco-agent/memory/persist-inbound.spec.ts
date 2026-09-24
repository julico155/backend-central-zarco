import { persistCustomerInbound } from './persist-inbound';
import type { AgentInboundMessage, AgentStore } from '../core/types';

function fakeStore(overrides: Partial<AgentStore> = {}): AgentStore & { inserted: unknown[] } {
  const inserted: unknown[] = [];
  return {
    inserted,
    async upsertConversation() {
      return { id: 'conv-1', state: 'active' };
    },
    async insertMessage(input) {
      inserted.push(input);
      return 'inserted';
    },
    async touchCustomerMessageAt() {},
    async touchHumanMessageAt() {},
    async pauseConversation() {
      return 'paused';
    },
    async renewPause() {
      return 'renewed';
    },
    async resumeConversation() {
      return 'resumed';
    },
    async insertControlEvent() {
      return 'inserted';
    },
    async hasResumeEvent() {
      return false;
    },
    async hasPauseEventForMessage() {
      return false;
    },
    async findPauseStateByPhone() {
      return null;
    },
    ...overrides,
  };
}

const message: AgentInboundMessage = {
  providerMessageId: 'wamid.1',
  providerConversationId: 'prov-conv-1',
  customerPhone: '59170000000',
  providerPhoneNumberId: 'phone-1',
  messageTimestamp: '2026-01-01T00:00:00.000Z',
  content: 'hola',
  contentType: 'text',
  metadata: null,
  image: null,
};

describe('persistCustomerInbound', () => {
  it('crea/reutiliza la conversación por teléfono y persiste el mensaje', async () => {
    const store = fakeStore();
    const result = await persistCustomerInbound(message, store);

    expect(result).toEqual({ result: 'persisted', conversationId: 'conv-1' });
    expect(store.inserted).toEqual([
      expect.objectContaining({
        agentConversationId: 'conv-1',
        direction: 'inbound',
        role: 'user',
        actor: 'customer',
        content: 'hola',
      }),
    ]);
  });

  it('sin teléfono, rechaza sin tocar la base', async () => {
    const upsertConversation = jest.fn();
    const store = fakeStore({ upsertConversation });
    const result = await persistCustomerInbound({ ...message, customerPhone: '' }, store);

    expect(result).toEqual({ result: 'rejected', reason: 'missing_phone' });
    expect(upsertConversation).not.toHaveBeenCalled();
  });

  it('un pin de ubicación se persiste con content NULL y las coordenadas en metadata', async () => {
    const store = fakeStore();
    await persistCustomerInbound(
      {
        ...message,
        providerMessageId: 'wamid.location',
        content: null,
        contentType: 'location',
        metadata: { latitude: -17.78, longitude: -63.18 },
      },
      store,
    );

    expect(store.inserted).toEqual([
      expect.objectContaining({
        content: null,
        contentType: 'location',
        metadata: { latitude: -17.78, longitude: -63.18 },
      }),
    ]);
  });

  it('una reentrega del mismo WAMID se reporta como duplicate', async () => {
    const store = fakeStore({
      async insertMessage() {
        return 'duplicate';
      },
    });
    const result = await persistCustomerInbound(message, store);
    expect(result).toEqual({ result: 'duplicate', conversationId: 'conv-1' });
  });
});

import { resumeAgentConversation } from './resume';
import type { AgentStore } from '../core/types';

interface Row {
  id: string;
  state: 'active' | 'paused';
  resumedAt: string | null;
}

function makeStore() {
  const conversations = new Map<string, Row>();
  const controlEvents: { action: string; source: string; metadata: unknown }[] = [];

  const store: AgentStore = {
    async upsertConversation() {
      throw new Error('resume no debe crear conversaciones');
    },
    async insertMessage() {
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
    async resumeConversation(input) {
      const row = [...conversations.values()].find((r) => r.id === input.agentConversationId)!;
      if (row.state !== 'paused') return 'already_active';
      row.state = 'active';
      row.resumedAt = input.resumedAt;
      return 'resumed';
    },
    async insertControlEvent(input) {
      controlEvents.push({ action: input.action, source: input.source, metadata: input.metadata });
      return 'inserted';
    },
    async hasResumeEvent(_id, resumedAt) {
      return controlEvents.some(
        (e) =>
          e.action === 'resume' &&
          (e.metadata as { resumed_at?: string })?.resumed_at === resumedAt,
      );
    },
    async hasPauseEventForMessage() {
      return false;
    },
    async findPauseStateByPhone(customerPhone) {
      const row = conversations.get(customerPhone);
      if (!row) return null;
      return {
        conversationId: row.id,
        state: row.state,
        pausedAt: row.state === 'paused' ? '2026-01-01T00:00:00.000Z' : null,
        pauseExpiresAt: null,
        pauseReason: row.state === 'paused' ? 'handoff_requested' : null,
        pauseSource: row.state === 'paused' ? 'system' : null,
        resumedAt: row.resumedAt,
      };
    },
  };

  return { store, conversations, controlEvents };
}

describe('resumeAgentConversation', () => {
  it('reanuda una conversación pausada y deja un evento de control resume', async () => {
    const { store, conversations, controlEvents } = makeStore();
    conversations.set('59170000000', { id: 'conv-1', state: 'paused', resumedAt: null });

    const result = await resumeAgentConversation(
      '59170000000',
      store,
      () => '2026-01-01T01:00:00.000Z',
    );

    expect(result).toEqual({
      result: 'ok',
      conversationId: 'conv-1',
      transition: 'resumed',
      controlEvent: 'inserted',
    });
    expect(conversations.get('59170000000')!.state).toBe('active');
    expect(controlEvents).toHaveLength(1);
    expect(controlEvents[0].action).toBe('resume');
  });

  it('sin conversación para ese teléfono, not_found', async () => {
    const { store } = makeStore();
    const result = await resumeAgentConversation('59171111111', store);
    expect(result).toEqual({ result: 'not_found' });
  });

  it('sin teléfono, rejected sin tocar la base', async () => {
    const { store } = makeStore();
    const result = await resumeAgentConversation('', store);
    expect(result).toEqual({ result: 'rejected', reason: 'missing_phone' });
  });

  it('una conversación ya activa, con su evento de resume ya registrado, no lo duplica', async () => {
    const { store, conversations, controlEvents } = makeStore();
    const resumedAt = new Date('2026-01-01T00:30:00.000Z').toISOString();
    conversations.set('59170000000', { id: 'conv-1', state: 'active', resumedAt });
    controlEvents.push({ action: 'resume', source: 'api', metadata: { resumed_at: resumedAt } });

    const result = await resumeAgentConversation(
      '59170000000',
      store,
      () => '2026-01-01T01:00:00.000Z',
    );

    expect(result.result).toBe('ok');
    if (result.result !== 'ok') throw new Error('unreachable');
    expect(result.transition).toBe('already_active');
    expect(result.controlEvent).toBe('duplicate');
    // Sigue habiendo UN solo evento de resume: no se insertó otro.
    expect(controlEvents.filter((e) => e.action === 'resume')).toHaveLength(1);
  });
});

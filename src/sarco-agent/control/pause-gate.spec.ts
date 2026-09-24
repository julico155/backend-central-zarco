import { isPauseActive, isPauseExpired } from './pause-gate';
import type { AgentPauseState } from '../core/types';

function state(overrides: Partial<AgentPauseState> = {}): AgentPauseState {
  return {
    conversationId: 'conv-1',
    state: 'paused',
    pausedAt: '2026-01-01T00:00:00.000Z',
    pauseExpiresAt: null,
    pauseReason: 'human_whatsapp_business_app',
    pauseSource: 'business_app',
    resumedAt: null,
    ...overrides,
  };
}

describe('isPauseActive', () => {
  it('una conversación desconocida (null) no está pausada', () => {
    expect(isPauseActive(null, '2026-01-01T00:00:00.000Z')).toBe(false);
  });

  it('activa nunca está pausada', () => {
    expect(
      isPauseActive(state({ state: 'active', pauseExpiresAt: null }), '2026-01-01T00:00:00.000Z'),
    ).toBe(false);
  });

  it('pausada sin vencimiento es indefinida: siempre activa', () => {
    expect(isPauseActive(state({ pauseExpiresAt: null }), '2099-01-01T00:00:00.000Z')).toBe(true);
  });

  it('pausada con vencimiento futuro retiene al agente', () => {
    const s = state({ pauseExpiresAt: '2026-01-01T01:00:00.000Z' });
    expect(isPauseActive(s, '2026-01-01T00:30:00.000Z')).toBe(true);
  });

  it('pausada con vencimiento pasado ya no retiene', () => {
    const s = state({ pauseExpiresAt: '2026-01-01T01:00:00.000Z' });
    expect(isPauseActive(s, '2026-01-01T02:00:00.000Z')).toBe(false);
  });

  it('fail-closed: una fecha ilegible se trata como vigente', () => {
    const s = state({ pauseExpiresAt: 'not-a-date' });
    expect(isPauseActive(s, '2026-01-01T00:00:00.000Z')).toBe(true);
  });
});

describe('isPauseExpired', () => {
  it('una pausa vencida que sigue escrita como paused está expired', () => {
    const s = state({ pauseExpiresAt: '2026-01-01T01:00:00.000Z' });
    expect(isPauseExpired(s, '2026-01-01T02:00:00.000Z')).toBe(true);
  });

  it('una conversación activa nunca está expired (no hay nada que normalizar)', () => {
    expect(isPauseExpired(state({ state: 'active' }), '2099-01-01T00:00:00.000Z')).toBe(false);
  });
});

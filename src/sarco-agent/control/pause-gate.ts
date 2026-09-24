import type { AgentPauseState, AgentStore } from '../core/types';

/**
 * Barreras de pausa del Agent Core. Puerto directo de sarcoRestaurant
 * (src/lib/agent/control/pause-gate.ts, Fase 6D.2F.2B/5C.1).
 *
 * IMPORTANTE: la pausa es SOLO del Agent Core. Las comunicaciones
 * determinísticas de Backend Central (fuera de esta fase) no pasan por aquí.
 */

/** `true` si el agente puede actuar. Una conversación desconocida está activa. */
export function isAgentConversationActive(state: AgentPauseState | null): boolean {
  if (state === null) return true;
  return state.state === 'active';
}

/** `true` si un humano (o el panel/API) tiene el control. */
export function isAgentConversationPaused(state: AgentPauseState | null): boolean {
  return !isAgentConversationActive(state);
}

/**
 * ¿La pausa RETIENE al agente en este instante? No es lo mismo que
 * `isAgentConversationPaused`: una fila puede decir `paused` y su vencimiento
 * ya haber pasado. Fail-closed ante una fecha ilegible: se considera vigente.
 */
export function isPauseActive(state: AgentPauseState | null, nowIso: string): boolean {
  if (state === null || state.state !== 'paused') return false;
  if (state.pauseExpiresAt === null) return true;

  const expires = Date.parse(state.pauseExpiresAt);
  if (Number.isNaN(expires)) return true;

  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) return true;

  return expires > now;
}

/** ¿Es una pausa que YA venció y sigue escrita como `paused`? */
export function isPauseExpired(state: AgentPauseState | null, nowIso: string): boolean {
  return isAgentConversationPaused(state) && !isPauseActive(state, nowIso);
}

/** Estado de control de la conversación de un teléfono, o `null` si todavía no existe. */
export async function getConversationPauseState(
  customerPhone: string,
  store: AgentStore,
): Promise<AgentPauseState | null> {
  if (customerPhone === '') return null;
  return store.findPauseStateByPhone(customerPhone);
}

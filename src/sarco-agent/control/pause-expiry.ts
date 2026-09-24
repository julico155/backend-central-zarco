import { RESUME_REASON_TAKEOVER_EXPIRED, type AgentStore } from '../core/types';
import { isPauseExpired } from './pause-gate';
import { resumeAgentConversation, type ResumeAttribution } from './resume';

/**
 * Normalización PEREZOSA de una pausa vencida. Puerto directo de
 * sarcoRestaurant (src/lib/agent/control/pause-expiry.ts, Fase 6D.2F.5C.1):
 * se resuelve al vuelo, en el mismo mensaje que ya dispara el turno — sin cron.
 */
export const EXPIRED_TAKEOVER_RESUME: ResumeAttribution = {
  source: 'system',
  reason: RESUME_REASON_TAKEOVER_EXPIRED,
};

export type PauseExpiryOutcome = 'not_expired' | 'resumed' | 'already_active' | 'no_conversation';

/** Si la pausa de este teléfono venció, devuelve el control al agente. Idempotente. */
export async function resolveExpiredPause(
  customerPhone: string,
  store: AgentStore,
  now: () => string = () => new Date().toISOString(),
): Promise<PauseExpiryOutcome> {
  if (customerPhone === '') return 'no_conversation';

  const state = await store.findPauseStateByPhone(customerPhone);
  if (state === null) return 'no_conversation';
  if (!isPauseExpired(state, now())) return 'not_expired';

  const result = await resumeAgentConversation(customerPhone, store, now, EXPIRED_TAKEOVER_RESUME);

  if (result.result !== 'ok') return 'no_conversation';
  return result.transition === 'resumed' ? 'resumed' : 'already_active';
}

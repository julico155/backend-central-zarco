import {
  RESUME_REASON_MANUAL_API,
  type AgentStore,
  type InsertControlEventResult,
  type ResumeAgentResult,
} from '../core/types';
import type { AgentControlSource } from '../../database/agent-types';

/**
 * Resume de una conversación pausada. Puerto directo de sarcoRestaurant
 * (src/lib/agent/control/resume.ts, Fase 6D.2F.5C.1).
 */
export interface ResumeAttribution {
  source: AgentControlSource;
  /** Formato `[A-Za-z0-9._:-]{1,64}`. */
  reason: string;
}

export const MANUAL_API_RESUME: ResumeAttribution = {
  source: 'api',
  reason: RESUME_REASON_MANUAL_API,
};

/**
 * Secuencia: localizar la conversación por teléfono → transición condicional
 * `paused → active` → registrar el evento de control `resume`. Idempotente
 * por `resumed_at` (canonicalizado con `toISOString()`): 0014 solo lo permite
 * poblado mientras la conversación está `active`.
 */
export async function resumeAgentConversation(
  customerPhone: string,
  store: AgentStore,
  now: () => string = () => new Date().toISOString(),
  attribution: ResumeAttribution = MANUAL_API_RESUME,
): Promise<ResumeAgentResult> {
  if (customerPhone === '') {
    return { result: 'rejected', reason: 'missing_phone' };
  }

  const before = await store.findPauseStateByPhone(customerPhone);
  if (before === null) {
    return { result: 'not_found' };
  }

  const resumedAt = now();
  const transition = await store.resumeConversation({
    agentConversationId: before.conversationId,
    resumedAt,
  });

  let effectiveResumedAt: string | null;
  if (transition === 'resumed') {
    effectiveResumedAt = resumedAt;
  } else {
    const after = await store.findPauseStateByPhone(customerPhone);
    effectiveResumedAt = after?.resumedAt ? new Date(after.resumedAt).toISOString() : null;
  }

  let controlEvent: InsertControlEventResult = 'duplicate';
  if (effectiveResumedAt !== null) {
    const alreadyRegistered = await store.hasResumeEvent(before.conversationId, effectiveResumedAt);
    if (!alreadyRegistered) {
      controlEvent = await store.insertControlEvent({
        agentConversationId: before.conversationId,
        action: 'resume',
        source: attribution.source,
        reason: attribution.reason,
        providerMessageId: null,
        metadata: { resumed_at: effectiveResumedAt },
      });
    }
  }

  return {
    result: 'ok',
    conversationId: before.conversationId,
    transition,
    controlEvent,
  };
}

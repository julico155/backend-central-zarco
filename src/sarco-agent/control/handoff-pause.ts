import type { AgentStore } from '../core/types';
import type { AgentControlSource } from '../../database/types';
import { pauseExpiryFrom } from './takeover';

/**
 * Pausar el agente porque lo decide el SISTEMA (no un mensaje humano desde
 * WhatsApp Business App). Puerto directo de sarcoRestaurant
 * (src/lib/agent/control/handoff-pause.ts).
 *
 * Con vencimiento y no indefinida: Backend Central no tiene todavía panel
 * para reanudar manualmente, así que una pausa que nadie levante dejaría a
 * ese cliente sin agente para siempre. `resolveExpiredPause` ya la limpia sola.
 */
export type HandoffTrigger = 'agent_action' | 'stuck_customer' | 'payment_review';

export interface PauseForHandoffInput {
  customerPhone: string;
  /** Motivo canónico: `[A-Za-z0-9._:-]{1,64}`. */
  reason: string;
  source: AgentControlSource;
  /** WAMID que origina la derivación, o `null` cuando no nace de un mensaje. */
  sourceMessageId: string | null;
  minutes: number;
  trigger: HandoffTrigger;
}

export type PauseForHandoffResult =
  | {
      result: 'ok';
      conversationId: string;
      pause: 'paused' | 'already_paused' | 'already_applied';
      pauseExpiresAt: string;
    }
  | { result: 'rejected'; reason: 'missing_phone' };

/** Pausa la conversación de un cliente por decisión del sistema. No manda ningún mensaje. */
export async function pauseAgentForHandoff(
  input: PauseForHandoffInput,
  store: AgentStore,
  now: () => string = () => new Date().toISOString(),
): Promise<PauseForHandoffResult> {
  if (input.customerPhone.trim() === '') {
    return { result: 'rejected', reason: 'missing_phone' };
  }

  const conversation = await store.upsertConversation({
    customerPhone: input.customerPhone,
    providerConversationId: null,
    providerPhoneNumberId: null,
  });

  const pausedAt = now();
  const pauseExpiresAt = pauseExpiryFrom(pausedAt, input.minutes);

  if (input.sourceMessageId !== null) {
    const yaAplicado = await store.hasPauseEventForMessage(conversation.id, input.sourceMessageId);
    if (yaAplicado) {
      return {
        result: 'ok',
        conversationId: conversation.id,
        pause: 'already_applied',
        pauseExpiresAt,
      };
    }
  }

  const pause = await store.pauseConversation({
    agentConversationId: conversation.id,
    pausedAt,
    pauseExpiresAt,
    reason: input.reason,
    source: input.source,
  });

  await store.insertControlEvent({
    agentConversationId: conversation.id,
    action: 'pause',
    source: input.source,
    reason: input.reason,
    providerMessageId: input.sourceMessageId,
    expiresAt: pauseExpiresAt,
    metadata: { trigger: input.trigger },
  });

  return { result: 'ok', conversationId: conversation.id, pause, pauseExpiresAt };
}

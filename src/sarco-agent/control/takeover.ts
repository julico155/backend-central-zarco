import type { AgentInboundMessage, AgentStore, HumanTakeoverResult } from '../core/types';
import { PAUSE_REASON_HUMAN_BUSINESS_APP } from '../core/types';

/**
 * Human takeover. Puerto directo de sarcoRestaurant
 * (src/lib/agent/control/takeover.ts, Fase 6D.2F.2B, TTL en 6D.2F.5C.1).
 *
 * Se dispara SOLO con `whatsapp.message.sent` + `direction=outbound` +
 * `origin=business_app` — lo decide el adaptador de mensajes
 * (`../kapso-message.ts`), no este módulo.
 */

export const DEFAULT_HUMAN_TAKEOVER_PAUSE_MINUTES = 30;
export const MIN_HUMAN_TAKEOVER_PAUSE_MINUTES = 1;
export const MAX_HUMAN_TAKEOVER_PAUSE_MINUTES = 1440;

/**
 * Interpreta `HUMAN_TAKEOVER_PAUSE_MINUTES`. Fail-safe: cualquier valor que
 * no sea un entero dentro del rango cae al default y NO lanza.
 */
export function humanTakeoverPauseMinutes(raw: string | null | undefined): number {
  if (typeof raw !== 'string') return DEFAULT_HUMAN_TAKEOVER_PAUSE_MINUTES;

  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return DEFAULT_HUMAN_TAKEOVER_PAUSE_MINUTES;

  const minutes = Number(trimmed);
  if (
    !Number.isSafeInteger(minutes) ||
    minutes < MIN_HUMAN_TAKEOVER_PAUSE_MINUTES ||
    minutes > MAX_HUMAN_TAKEOVER_PAUSE_MINUTES
  ) {
    return DEFAULT_HUMAN_TAKEOVER_PAUSE_MINUTES;
  }
  return minutes;
}

/** Vencimiento de la pausa a partir del instante de la intervención humana. */
export function pauseExpiryFrom(pausedAt: string, minutes: number): string {
  return new Date(Date.parse(pausedAt) + minutes * 60_000).toISOString();
}

/**
 * Human takeover — lógica PURA sobre un `AgentStore` inyectado.
 *
 * Secuencia: upsert de conversación → ¿este wamid ya completó su takeover? →
 * persistir el mensaje humano REAL → avanzar `last_human_message_at` →
 * pausar (o renovar el plazo) → registrar el evento de control.
 *
 * Un WAMID humano produce UN takeover, y solo uno: la marca durable es el
 * evento de control (última escritura de la secuencia), así que si existe
 * para este wamid, las anteriores también ocurrieron.
 */
export async function handleHumanTakeover(
  message: AgentInboundMessage,
  store: AgentStore,
  now: () => string = () => new Date().toISOString(),
  pauseMinutes: number = DEFAULT_HUMAN_TAKEOVER_PAUSE_MINUTES,
): Promise<HumanTakeoverResult> {
  if (message.customerPhone === '') {
    return { result: 'rejected', reason: 'missing_phone' };
  }
  if (message.providerMessageId === null) {
    return { result: 'rejected', reason: 'missing_message_id' };
  }

  const conversation = await store.upsertConversation({
    customerPhone: message.customerPhone,
    providerConversationId: message.providerConversationId,
    providerPhoneNumberId: message.providerPhoneNumberId,
  });

  const yaAplicado = await store.hasPauseEventForMessage(
    conversation.id,
    message.providerMessageId,
  );
  if (yaAplicado) {
    return {
      result: 'ok',
      conversationId: conversation.id,
      message: 'duplicate',
      pause: 'already_applied',
      controlEvent: 'duplicate',
    };
  }

  const messageTimestamp = message.messageTimestamp ?? now();

  const inserted = await store.insertMessage({
    agentConversationId: conversation.id,
    providerMessageId: message.providerMessageId,
    providerConversationId: message.providerConversationId,
    direction: 'outbound',
    role: 'assistant',
    actor: 'human',
    content: message.content,
    contentType: message.contentType,
    metadata: message.metadata,
    messageTimestamp,
  });

  await store.touchHumanMessageAt(conversation.id, messageTimestamp);

  const pauseExpiresAt = pauseExpiryFrom(messageTimestamp, pauseMinutes);

  const pause = await store.pauseConversation({
    agentConversationId: conversation.id,
    pausedAt: messageTimestamp,
    pauseExpiresAt,
    reason: PAUSE_REASON_HUMAN_BUSINESS_APP,
    source: 'business_app',
  });

  if (pause === 'already_paused' && inserted === 'inserted') {
    await store.renewPause({
      agentConversationId: conversation.id,
      pauseExpiresAt,
      reason: PAUSE_REASON_HUMAN_BUSINESS_APP,
      source: 'business_app',
    });
  }

  const controlEvent = await store.insertControlEvent({
    agentConversationId: conversation.id,
    action: 'pause',
    source: 'business_app',
    reason: PAUSE_REASON_HUMAN_BUSINESS_APP,
    providerMessageId: message.providerMessageId,
    expiresAt: pauseExpiresAt,
    metadata: { trigger: 'whatsapp.message.sent' },
  });

  return {
    result: 'ok',
    conversationId: conversation.id,
    message: inserted,
    pause,
    controlEvent,
  };
}

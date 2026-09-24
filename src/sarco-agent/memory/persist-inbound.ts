import type { AgentInboundMessage, AgentStore, PersistInboundResult } from '../core/types';

/**
 * Persistencia del historial ENTRANTE del cliente. Puerto directo de
 * sarcoRestaurant (src/lib/agent/memory/persist-inbound.ts, Fase 6D.2F.2B).
 *
 * Se ejecuta para todo mensaje real del cliente, sea del tipo que sea. Dos
 * reglas que no se negocian:
 *
 *  1. NO se inventan marcadores: un pin de GPS se guarda con `content = NULL`
 *     y sus coordenadas en `metadata`.
 *  2. NO se consulta el estado de pausa: que un humano tenga el control
 *     impide que hable la IA, nunca que se registre la conversación.
 */
export async function persistCustomerInbound(
  message: AgentInboundMessage,
  store: AgentStore,
  now: () => string = () => new Date().toISOString(),
): Promise<PersistInboundResult> {
  if (message.customerPhone === '') {
    return { result: 'rejected', reason: 'missing_phone' };
  }

  const conversation = await store.upsertConversation({
    customerPhone: message.customerPhone,
    providerConversationId: message.providerConversationId,
    providerPhoneNumberId: message.providerPhoneNumberId,
  });

  const messageTimestamp = message.messageTimestamp ?? now();

  const inserted = await store.insertMessage({
    agentConversationId: conversation.id,
    providerMessageId: message.providerMessageId,
    providerConversationId: message.providerConversationId,
    direction: 'inbound',
    role: 'user',
    actor: 'customer',
    content: message.content,
    contentType: message.contentType,
    metadata: message.metadata,
    messageTimestamp,
  });

  await store.touchCustomerMessageAt(conversation.id, messageTimestamp);

  return {
    result: inserted === 'duplicate' ? 'duplicate' : 'persisted',
    conversationId: conversation.id,
  };
}

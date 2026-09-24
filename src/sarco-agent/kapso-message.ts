import type { NormalizedKapsoEvent } from '../kapso/kapso.types';
import type { AgentInboundMessage } from './core/types';

/**
 * Frontera entre el transporte de Kapso (ya normalizado por
 * `../kapso/kapso-normalizer.ts`) y el Agent Core. Construye el
 * `AgentInboundMessage` que consumen `persistCustomerInbound`, `runAgentTurn`
 * y `handleHumanTakeover` — para inbound (`whatsapp.message.received`) y
 * outbound (los cuatro eventos de reconciliación) por igual, ya que
 * `NormalizedKapsoEvent` extrae los campos correctos para cada uno.
 *
 * No hay `messageTimestamp` en `NormalizedKapsoEvent` (Kapso no siempre lo
 * manda de forma uniforme y esta fase no lo necesitaba hasta ahora): se deja
 * en `null` y cada consumidor cae a "ahora" de forma explícita, exactamente
 * como hacía sarcoRestaurant cuando el proveedor no traía un instante
 * interpretable.
 */
export function toAgentInboundMessage(event: NormalizedKapsoEvent): AgentInboundMessage {
  return {
    providerMessageId: event.messageId,
    providerConversationId: event.conversationId,
    customerPhone: event.customerPhone,
    providerPhoneNumberId: event.phoneNumberId,
    messageTimestamp: null,
    content: event.text,
    contentType: event.contentType,
    metadata: buildMetadata(event),
    image: event.image,
  };
}

function buildMetadata(event: NormalizedKapsoEvent): Record<string, unknown> | null {
  if (event.contentType === 'location' && event.location) {
    return { latitude: event.location.latitude, longitude: event.location.longitude };
  }
  if (event.contentType === 'interactive' && event.interactive?.type) {
    return { interactive_type: event.interactive.type };
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export type KapsoOutboundProvenance =
  /** `whatsapp.message.sent` escrito a mano desde WhatsApp Business App: dispara el takeover humano. */
  | 'human_business_app'
  /** Envío nuestro (cloud_api): reconciliación de negocio, fuera de alcance de esta fase. */
  | 'system_cloud_api'
  | 'unknown';

/**
 * Clasifica la PROCEDENCIA de un evento `whatsapp.message.sent`, leyendo
 * `message.kapso.direction`/`origin` del payload crudo — el mismo contrato
 * que `parseKapsoProvenance` en sarcoRestaurant, reducido a lo que esta fase
 * necesita para decidir si dispara el takeover humano.
 */
export function classifyOutboundProvenance(payload: unknown): KapsoOutboundProvenance {
  const root = record(payload);
  const message = record(root?.message);
  const kapso = record(message?.kapso);
  const direction = typeof kapso?.direction === 'string' ? kapso.direction : null;
  const origin = typeof kapso?.origin === 'string' ? kapso.origin : null;

  if (direction === 'outbound' && origin === 'business_app') return 'human_business_app';
  if (origin === 'cloud_api') return 'system_cloud_api';
  return 'unknown';
}

import {
  KAPSO_SUPPORTED_EVENT,
  KapsoContentType,
  KapsoMediaReference,
  NormalizedKapsoEvent,
  NormalizeResult,
} from './kapso.types';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function validLatitude(value: number | null): value is number {
  return value !== null && value >= -90 && value <= 90;
}

function validLongitude(value: number | null): value is number {
  return value !== null && value >= -180 && value <= 180;
}

function normalizePhone(value: string | null): string {
  return (value ?? '').replace(/\D+/g, '');
}

function media(message: UnknownRecord, type: 'image' | 'audio'): KapsoMediaReference | null {
  const value = record(message[type]);
  if (!value) return null;
  const kapso = record(message.kapso);
  const mediaData = record(kapso?.media_data);
  const typeData = record(kapso?.message_type_data);
  return {
    id: string(value.id),
    url: string(value.link) ?? string(value.url) ?? string(kapso?.media_url),
    mimeType: string(value.mime_type) ?? string(mediaData?.content_type),
    caption: string(value.caption) ?? string(typeData?.caption),
  };
}

/**
 * Identidad estructural de un sobre para las validaciones de lote, igual que
 * `envelopePhone`/`declaredValues` en Sarco (`webhook/envelopes.ts`): SIEMPRE
 * lee la forma de una entrega individual (`message`/`conversation` en la raíz),
 * sin importar el evento real, porque el lote se valida antes de saber si el
 * evento es aceptado.
 */
function envelopeIdentity(payload: unknown): {
  phone: string;
  conversationId: string | null;
  phoneNumberId: string | null;
} {
  const root = record(payload) ?? {};
  const message = record(root.message);
  const conversation = record(root.conversation);
  return {
    phone: normalizePhone(string(conversation?.phone_number) ?? string(message?.from)),
    conversationId: string(conversation?.id),
    phoneNumberId: string(root.phone_number_id),
  };
}

/**
 * Construye el sobre de un evento entrante (`whatsapp.message.received`).
 * Espejo de `extractMessageContext` (Sarco): el `phone_number_id` sale SOLO de
 * la raíz, sin caer a `message.phone_number_id` ni a `metadata`.
 */
function normalizeReceivedEnvelope(
  root: UnknownRecord,
  eventName: string,
  eventId: string,
  envelopeIndex: number,
): NormalizedKapsoEvent {
  const message = record(root.message) ?? {};
  const conversation = record(root.conversation);
  const messageType = string(message.type);
  const contentType: KapsoContentType =
    messageType === 'text' ||
    messageType === 'image' ||
    messageType === 'audio' ||
    messageType === 'location' ||
    messageType === 'interactive'
      ? messageType
      : 'unknown';
  const location = record(message.location);
  const interactive = record(message.interactive);
  const buttonReply = record(interactive?.button_reply);
  const listReply = record(interactive?.list_reply);
  const latitude = number(location?.latitude);
  const longitude = number(location?.longitude);
  const image = contentType === 'image' ? media(message, 'image') : null;
  const audio = contentType === 'audio' ? media(message, 'audio') : null;

  return {
    eventName,
    eventId,
    envelopeIndex,
    messageId: string(message.id),
    customerPhone: normalizePhone(string(conversation?.phone_number) ?? string(message.from)),
    conversationId: string(conversation?.id),
    phoneNumberId: string(root.phone_number_id),
    contentType,
    text:
      contentType === 'text'
        ? string(record(message.text)?.body)
        : contentType === 'interactive'
          ? string(record(interactive?.body)?.text)
          : (image?.caption ?? audio?.caption ?? null),
    image,
    audio,
    location:
      contentType === 'location' && validLatitude(latitude) && validLongitude(longitude)
        ? {
            latitude,
            longitude,
            name: string(location?.name),
            address: string(location?.address),
            contextMessageId: string(record(message.context)?.id),
          }
        : null,
    interactive:
      contentType === 'interactive'
        ? {
            type: string(interactive?.type),
            id: string(buttonReply?.id) ?? string(listReply?.id),
            title: string(buttonReply?.title) ?? string(listReply?.title),
            flowResponse:
              record(message.kapso)?.flow_response ??
              string(record(interactive?.nfm_reply)?.response_json),
          }
        : null,
  };
}

/** Ubica el mensaje de un sobre saliente sin asumir una única envoltura (igual que `findMessage` en `outbound-event.ts`). */
function findOutboundMessage(root: UnknownRecord): UnknownRecord {
  return record(root.message) ?? record(record(root.data)?.message) ?? record(root.data) ?? root;
}

/**
 * Construye el sobre de uno de los cuatro eventos salientes de Kapso
 * (sent/delivered/read/failed). Espejo de campos de `parseOutboundEvent`
 * (Sarco): NO reutiliza la extracción de entrantes porque los campos reales
 * vienen de otro sitio (`message.to` en vez de `conversation.phone_number`,
 * `kapso.whatsapp_conversation_id` en vez de `conversation.id`, etc.).
 *
 * Solo se normalizan los campos de identidad y el texto: la clasificación de
 * negocio (tipo de notificación, número de pedido) queda fuera de esta fase a
 * propósito — ver cabecera del módulo.
 */
function normalizeOutboundEnvelope(
  root: UnknownRecord,
  eventName: string,
  eventId: string,
  envelopeIndex: number,
): NormalizedKapsoEvent {
  const message = findOutboundMessage(root);
  const kapso = record(message.kapso);
  const interactive = record(message.interactive);
  const text = record(message.text);
  const image = record(message.image);

  const bodyText =
    string(text?.body) ?? string(record(interactive?.body)?.text) ?? string(image?.caption);

  return {
    eventName,
    eventId,
    envelopeIndex,
    messageId: string(message.id) ?? string(message.message_id) ?? string(root.message_id),
    customerPhone: normalizePhone(string(message.to) ?? string(root.to)),
    conversationId:
      string(kapso?.whatsapp_conversation_id) ??
      string(message.conversation_id) ??
      string(root.conversation_id),
    phoneNumberId:
      string(root.phone_number_id) ??
      string(message.phone_number_id) ??
      string(record(root.metadata)?.phone_number_id),
    contentType: bodyText !== null ? 'text' : 'unknown',
    text: bodyText,
    image: null,
    audio: null,
    location: null,
    interactive: null,
  };
}

function normalizeEnvelope(
  payload: unknown,
  eventName: string,
  eventId: string,
  envelopeIndex: number,
): NormalizedKapsoEvent {
  const root = record(payload) ?? {};
  return eventName === KAPSO_SUPPORTED_EVENT
    ? normalizeReceivedEnvelope(root, eventName, eventId, envelopeIndex)
    : normalizeOutboundEnvelope(root, eventName, eventId, envelopeIndex);
}

export interface KapsoEnvelope {
  index: number;
  payload: unknown;
}

export type EnvelopeParseResult =
  | { ok: true; batched: boolean; envelopes: KapsoEnvelope[] }
  | {
      ok: false;
      status: 400 | 422;
      error: 'invalid_json' | 'unsupported_batch';
      reason?: string;
    };

/**
 * Parseo ESTRUCTURAL de lote/entrega individual, sin conocer el evento.
 * Espejo de `toEnvelopes` (Sarco `webhook/envelopes.ts`): valida forma y
 * coherencia del lote ANTES de que el llamador decida si el evento se acepta.
 */
export function parseKapsoEnvelopes(rawBody: string): EnvelopeParseResult {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' };
  }

  const root = record(payload);
  if (!root || root.batch !== true) {
    return { ok: true, batched: false, envelopes: [{ index: 0, payload }] };
  }

  if (!Array.isArray(root.data)) {
    return { ok: false, status: 422, error: 'unsupported_batch', reason: 'batch_data_not_array' };
  }
  if (root.data.length === 0) {
    return { ok: false, status: 422, error: 'unsupported_batch', reason: 'batch_data_empty' };
  }
  if (!record(root.batch_info)) {
    return {
      ok: false,
      status: 422,
      error: 'unsupported_batch',
      reason: 'batch_missing_batch_info',
    };
  }

  const envelopes: KapsoEnvelope[] = [];
  for (const [index, entry] of root.data.entries()) {
    if (record(entry) === null || record(record(entry)?.message) === null) {
      return {
        ok: false,
        status: 422,
        error: 'unsupported_batch',
        reason: 'batch_element_invalid',
      };
    }
    envelopes.push({ index, payload: entry });
  }

  const identities = envelopes.map((envelope) => envelopeIdentity(envelope.payload));
  const phones = new Set(identities.map((identity) => identity.phone));
  if (phones.size > 1) {
    return {
      ok: false,
      status: 422,
      error: 'unsupported_batch',
      reason: 'batch_mixed_conversations',
    };
  }
  const conversationIds = new Set(
    identities
      .map((identity) => identity.conversationId)
      .filter((value): value is string => value !== null),
  );
  if (conversationIds.size > 1) {
    return {
      ok: false,
      status: 422,
      error: 'unsupported_batch',
      reason: 'batch_mixed_conversation_ids',
    };
  }
  const phoneNumberIds = new Set(
    identities
      .map((identity) => identity.phoneNumberId)
      .filter((value): value is string => value !== null),
  );
  if (phoneNumberIds.size > 1) {
    return {
      ok: false,
      status: 422,
      error: 'unsupported_batch',
      reason: 'batch_mixed_phone_number_ids',
    };
  }

  return { ok: true, batched: true, envelopes };
}

/** Extracción semántica por evento. Asume sobres ya validados estructuralmente. */
export function buildNormalizedEvents(
  envelopes: readonly KapsoEnvelope[],
  eventName: string,
  eventId: string,
): NormalizedKapsoEvent[] {
  return envelopes.map(({ index, payload }) =>
    normalizeEnvelope(payload, eventName, eventId, index),
  );
}

/**
 * Adapta Kapso V2 individual y buffered deliveries sin interpretar intención
 * de negocio. Combina `parseKapsoEnvelopes` + `buildNormalizedEvents` para
 * quien reprocesa una fila ya aceptada (el lote de Kapso solo agrupa
 * `whatsapp.message.received`, así que a esta altura el evento ya es válido).
 */
export function normalizeKapsoPayload(
  rawBody: string,
  eventName: string,
  eventId: string,
): NormalizeResult {
  const parsed = parseKapsoEnvelopes(rawBody);
  if (!parsed.ok) return parsed;
  if (parsed.batched && eventName !== KAPSO_SUPPORTED_EVENT) {
    return {
      ok: false,
      status: 422,
      error: 'unsupported_batch',
      reason: 'batch_unsupported_event',
    };
  }
  return { ok: true, events: buildNormalizedEvents(parsed.envelopes, eventName, eventId) };
}

export const KAPSO_SUPPORTED_EVENT = 'whatsapp.message.received';
export const KAPSO_PAYLOAD_VERSION = 'v2';
export const KAPSO_OUTBOUND_EVENT_NAMES = [
  'whatsapp.message.sent',
  'whatsapp.message.delivered',
  'whatsapp.message.read',
  'whatsapp.message.failed',
] as const;

export function isKapsoAcceptedEvent(value: string | undefined): value is string {
  return value === KAPSO_SUPPORTED_EVENT || KAPSO_OUTBOUND_EVENT_NAMES.includes(value as never);
}

export type KapsoContentType = 'text' | 'image' | 'audio' | 'location' | 'interactive' | 'unknown';

export interface KapsoMediaReference {
  id: string | null;
  url: string | null;
  mimeType: string | null;
  caption: string | null;
}

export interface NormalizedKapsoEvent {
  eventName: string;
  eventId: string;
  envelopeIndex: number;
  messageId: string | null;
  customerPhone: string;
  conversationId: string | null;
  phoneNumberId: string | null;
  contentType: KapsoContentType;
  text: string | null;
  image: KapsoMediaReference | null;
  audio: KapsoMediaReference | null;
  location: {
    latitude: number;
    longitude: number;
    name: string | null;
    address: string | null;
    contextMessageId: string | null;
  } | null;
  interactive: {
    type: string | null;
    id: string | null;
    title: string | null;
    flowResponse: unknown | null;
  } | null;
}

export type NormalizeResult =
  | { ok: true; events: NormalizedKapsoEvent[] }
  | {
      ok: false;
      status: 400 | 422;
      error: 'invalid_json' | 'unsupported_batch';
      reason?: string;
    };

import { createHmac } from 'node:crypto';

export interface SignedWebhook {
  raw: string;
  headers: Record<string, string>;
}

/** Firma V2 de Kapso: HMAC-SHA256 hex del cuerpo exacto, sin prefijo. */
export function signKapsoBody(raw: string, secret: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

function envelope(phone: string, phoneNumberId: string, message: Record<string, unknown>) {
  return {
    message: { from: phone, timestamp: String(Math.floor(Date.now() / 1000)), ...message },
    conversation: { id: `e2e-conv-${phone}`, phone_number: phone },
    phone_number_id: phoneNumberId,
  };
}

export function signedInbound(
  payload: Record<string, unknown>,
  eventId: string,
  secret: string,
): SignedWebhook {
  const raw = JSON.stringify(payload);
  return {
    raw,
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': signKapsoBody(raw, secret),
      'x-webhook-payload-version': 'v2',
      'x-webhook-event': 'whatsapp.message.received',
      'x-idempotency-key': eventId,
    },
  };
}

export function inboundText(
  input: { phone: string; phoneNumberId: string; wamid: string; body: string; eventId: string },
  secret: string,
): SignedWebhook {
  return signedInbound(
    envelope(input.phone, input.phoneNumberId, {
      id: input.wamid,
      type: 'text',
      text: { body: input.body },
    }),
    input.eventId,
    secret,
  );
}

export function inboundLocation(
  input: {
    phone: string;
    phoneNumberId: string;
    wamid: string;
    latitude: number;
    longitude: number;
    eventId: string;
  },
  secret: string,
): SignedWebhook {
  return signedInbound(
    envelope(input.phone, input.phoneNumberId, {
      id: input.wamid,
      type: 'location',
      location: { latitude: input.latitude, longitude: input.longitude },
    }),
    input.eventId,
    secret,
  );
}

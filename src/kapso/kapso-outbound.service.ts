import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';

/**
 * Transporte SALIENTE hacia la API de Kapso. Puerto directo de
 * sarcoRestaurant (src/lib/kapso/transport.ts + client.ts), reducido a lo
 * que el agente necesita para quedar funcional en esta fase: texto plano.
 *
 * `POST {apiBaseUrl}/{phone_number_id}/messages`, header `X-API-Key`. NO usa
 * el gateway HTTP antiguo de sarcoRestaurant ni ningún endpoint del propio
 * Backend Central: es transporte directo a Kapso, igual que
 * `KapsoMediaResolverService` lo es para descargas.
 */

export type KapsoOutboundError =
  | 'invalid_phone'
  | 'invalid_text'
  | 'not_configured'
  | 'http_error'
  | 'invalid_response'
  | 'timeout'
  | 'network_error';

export type KapsoOutboundResult =
  { ok: true; wamid: string } | { ok: false; error: KapsoOutboundError; status?: number };

const DEFAULT_TIMEOUT_MS = 10_000;

function normalizePhone(value: string): string {
  return value.replace(/\D+/g, '');
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Valida solo la forma que se consume: `messages[0].id` como cadena no vacía. */
function extractWamid(json: unknown): string | null {
  const root = record(json);
  const messages = root?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const first = record(messages[0]);
  const id = first?.id;
  return typeof id === 'string' && id.trim() !== '' ? id : null;
}

@Injectable()
export class KapsoOutboundService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /** Envía un mensaje de texto simple y devuelve el wamid. Nunca lanza. */
  async sendText(
    customerPhone: string,
    text: string,
    phoneNumberId?: string | null,
  ): Promise<KapsoOutboundResult> {
    const to = normalizePhone(customerPhone);
    if (!to) return { ok: false, error: 'invalid_phone' };
    if (text.trim() === '') return { ok: false, error: 'invalid_text' };

    const kapso = this.config.get('kapso', { infer: true });
    if (!kapso.apiKey) return { ok: false, error: 'not_configured' };
    const targetPhoneNumberId = phoneNumberId || kapso.phoneNumberId;
    if (!targetPhoneNumberId) return { ok: false, error: 'not_configured' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const res = await fetch(`${kapso.apiBaseUrl}/${targetPhoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-API-Key': kapso.apiKey,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { body: text },
        }),
        signal: controller.signal,
      });

      if (!res.ok) return { ok: false, error: 'http_error', status: res.status };

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return { ok: false, error: 'invalid_response' };
      }

      const wamid = extractWamid(json);
      if (wamid === null) return { ok: false, error: 'invalid_response' };

      return { ok: true, wamid };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { ok: false, error: 'timeout' };
      }
      return { ok: false, error: 'network_error' };
    } finally {
      clearTimeout(timer);
    }
  }
}

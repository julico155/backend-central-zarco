import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';

/**
 * Transporte SALIENTE hacia la API de Kapso. Puerto directo de
 * sarcoRestaurant (src/lib/kapso/transport.ts + client.ts), reducido a lo
 * que el agente y el menú web necesitan para quedar funcionales en esta
 * fase: texto plano y el CTA interactivo "Ver menú".
 *
 * `POST {apiBaseUrl}/{phone_number_id}/messages`, header `X-API-Key`. NO usa
 * el gateway HTTP antiguo de sarcoRestaurant ni ningún endpoint del propio
 * Backend Central: es transporte directo a Kapso, igual que
 * `KapsoMediaResolverService` lo es para descargas.
 */

export type KapsoOutboundError =
  | 'invalid_phone'
  | 'invalid_text'
  | 'invalid_url'
  | 'invalid_media'
  | 'not_configured'
  | 'http_error'
  | 'invalid_response'
  | 'timeout'
  | 'network_error';

export type KapsoOutboundResult =
  { ok: true; wamid: string } | { ok: false; error: KapsoOutboundError; status?: number };

export type KapsoMediaUploadResult =
  { ok: true; mediaId: string } | { ok: false; error: KapsoOutboundError; status?: number };

const DEFAULT_TIMEOUT_MS = 10_000;

/** Copy canónico de la petición de ubicación (idéntico al de sarcoRestaurant). */
export const LOCATION_REQUEST_BODY_TEXT =
  'Por favor comparte tu ubicación actual para coordinar el delivery.';
export const LOCATION_HOW_TO_TEXT = 'Toca el clip 📎 → Ubicación → ENVIAR UBICACIÓN ACTUAL';

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

export interface SendMenuCtaUrlInput {
  customerPhone: string;
  phoneNumberId?: string | null;
  /** URL de la sesión del menú, entera. */
  menuUrl: string;
  /** Imagen de portada del header del CTA. */
  coverImageUrl: string;
  bodyText: string;
  /** Etiqueta del botón (WhatsApp la limita a 20 caracteres). */
  buttonText: string;
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

    return this.postMessage(phoneNumberId ?? null, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text },
    });
  }

  /**
   * Petición de ubicación: TEXTO plano con las instrucciones dentro (el botón
   * `location_request_message` se quitó en sarcoRestaurant porque atascaba el
   * último paso del flujo). Devuelve el wamid.
   */
  async sendLocationRequest(
    customerPhone: string,
    phoneNumberId?: string | null,
  ): Promise<KapsoOutboundResult> {
    return this.sendText(
      customerPhone,
      `${LOCATION_REQUEST_BODY_TEXT}

${LOCATION_HOW_TO_TEXT}`,
      phoneNumberId,
    );
  }

  /** Sube una imagen privada a la Media API (nunca viaja como URL pública). */
  async uploadImage(
    bytes: Buffer,
    contentType: string,
    phoneNumberId?: string | null,
  ): Promise<KapsoMediaUploadResult> {
    if (bytes.byteLength === 0 || (contentType !== 'image/png' && contentType !== 'image/jpeg')) {
      return { ok: false, error: 'invalid_media' };
    }
    const kapso = this.config.get('kapso', { infer: true });
    const targetPhoneNumberId = phoneNumberId || kapso.phoneNumberId;
    if (!kapso.apiKey || !targetPhoneNumberId) return { ok: false, error: 'not_configured' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', 'image');
      const blobBytes = new Uint8Array(bytes.byteLength);
      blobBytes.set(bytes);
      form.append(
        'file',
        new Blob([blobBytes], { type: contentType }),
        contentType === 'image/png' ? 'image.png' : 'image.jpg',
      );

      const res = await fetch(`${kapso.apiBaseUrl}/${targetPhoneNumberId}/media`, {
        method: 'POST',
        headers: { 'X-API-Key': kapso.apiKey },
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, error: 'http_error', status: res.status };

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return { ok: false, error: 'invalid_response' };
      }
      const id = record(json)?.id;
      if (typeof id !== 'string' || id.trim() === '')
        return { ok: false, error: 'invalid_response' };
      return { ok: true, mediaId: id };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { ok: false, error: 'timeout' };
      }
      return { ok: false, error: 'network_error' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Imagen ya subida (media id), con pie opcional. Devuelve el wamid. */
  async sendImageByMediaId(
    customerPhone: string,
    mediaId: string,
    caption?: string,
    phoneNumberId?: string | null,
  ): Promise<KapsoOutboundResult> {
    const to = normalizePhone(customerPhone);
    if (!to) return { ok: false, error: 'invalid_phone' };
    if (mediaId.trim() === '') return { ok: false, error: 'invalid_media' };
    const hasCaption = typeof caption === 'string' && caption.trim() !== '';

    return this.postMessage(phoneNumberId ?? null, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'image',
      image: { id: mediaId.trim(), ...(hasCaption ? { caption } : {}) },
    });
  }

  /**
   * Mensaje interactivo `cta_url` con el botón "Ver menú" (o "MODIFICAR MI
   * PEDIDO", etc. — el texto lo decide quien llama). Mismo payload que
   * `buildMenuCtaPayload` en sarcoRestaurant.
   */
  async sendMenuCtaUrl(input: SendMenuCtaUrlInput): Promise<KapsoOutboundResult> {
    const to = normalizePhone(input.customerPhone);
    if (!to) return { ok: false, error: 'invalid_phone' };
    if (input.bodyText.trim() === '') return { ok: false, error: 'invalid_text' };
    if (input.menuUrl.trim() === '' || input.coverImageUrl.trim() === '') {
      return { ok: false, error: 'invalid_url' };
    }

    return this.postMessage(input.phoneNumberId ?? null, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        header: { type: 'image', image: { link: input.coverImageUrl } },
        body: { text: input.bodyText },
        action: {
          name: 'cta_url',
          parameters: { display_text: input.buttonText, url: input.menuUrl },
        },
      },
    });
  }

  private async postMessage(
    phoneNumberId: string | null,
    payload: Record<string, unknown>,
  ): Promise<KapsoOutboundResult> {
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
        body: JSON.stringify(payload),
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

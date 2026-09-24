import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';

/**
 * Transporte DIRECTO a la Bot API de Telegram (`sendMessage` / `editMessageText`).
 * Reemplaza a `POST /gateway/telegram/alerts` de sarcoRestaurant: mismo cuerpo
 * (`chat_id`, `text`, `parse_mode` opcional, `disable_web_page_preview: true`),
 * mismos chats (`staff-group` y `delivery-group` → TELEGRAM_CHAT_ID) y el
 * `message_id` devuelto por Telegram como `externalMessageId`.
 *
 * Sin botones, sin `callback_query`, sin webhook: las motos siguen respondiendo
 * y citando el mensaje a mano. Nunca lanza; los errores son tipados y no
 * incluyen el token, el texto ni la respuesta remota.
 */

export type TelegramChatRef = 'staff-group' | 'delivery-group' | 'handoff-group';

export type TelegramSendError =
  | 'unknown_chat'
  | 'invalid_text'
  | 'not_configured'
  | 'http_error'
  | 'invalid_response'
  | 'timeout'
  | 'network_error';

export type TelegramSendResult =
  { ok: true; messageId: string } | { ok: false; error: TelegramSendError; status?: number };

export interface TelegramSendInput {
  chatRef: string;
  text: string;
  parseMode?: 'HTML';
  /** Si viene, edita ese mensaje en vez de mandar uno nuevo. */
  editMessageId?: string;
}

const DEFAULT_BASE_URL = 'https://api.telegram.org';
const TIMEOUT_MS = 10_000;
const MAX_TEXT_LENGTH = 4096;

@Injectable()
export class TelegramService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async send(input: TelegramSendInput): Promise<TelegramSendResult> {
    const telegram = this.config.get('telegram', { infer: true });
    const text = input.text.trim();
    if (text === '' || text.length > MAX_TEXT_LENGTH) return { ok: false, error: 'invalid_text' };

    const chatId = this.resolveChat(input.chatRef, telegram);
    if (chatId === null) return { ok: false, error: 'unknown_chat' };
    if (!telegram.botToken || !chatId) return { ok: false, error: 'not_configured' };

    const isEdit = input.editMessageId !== undefined;
    if (isEdit && !/^[1-9]\d*$/.test(input.editMessageId!)) {
      return { ok: false, error: 'invalid_text' };
    }

    const baseUrl = telegram.apiBaseUrl || DEFAULT_BASE_URL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(
        `${baseUrl}/bot${telegram.botToken}/${isEdit ? 'editMessageText' : 'sendMessage'}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            ...(isEdit ? { message_id: Number(input.editMessageId) } : {}),
            text,
            ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
            disable_web_page_preview: true,
          }),
          signal: controller.signal,
        },
      );
      if (!res.ok) return { ok: false, error: 'http_error', status: res.status };

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return { ok: false, error: 'invalid_response' };
      }
      const messageId = extractMessageId(json);
      if (messageId === null) return { ok: false, error: 'invalid_response' };
      return { ok: true, messageId };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { ok: false, error: 'timeout' };
      }
      return { ok: false, error: 'network_error' };
    } finally {
      clearTimeout(timer);
    }
  }

  private resolveChat(
    chatRef: string,
    telegram: { chatId: string; handoffChatId: string },
  ): string | null {
    switch (chatRef) {
      case 'staff-group':
      case 'delivery-group':
        return telegram.chatId;
      case 'handoff-group':
        // Sin grupo propio de atención humana cae al chat de siempre: un aviso
        // en el grupo equivocado sirve más que ninguno (mismo criterio que Sarco).
        return telegram.handoffChatId || telegram.chatId;
      default:
        return null;
    }
  }
}

function extractMessageId(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const root = json as Record<string, unknown>;
  if (root.ok !== true) return null;
  const result = root.result;
  if (typeof result !== 'object' || result === null) return null;
  const id = (result as Record<string, unknown>).message_id;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? String(id) : null;
}

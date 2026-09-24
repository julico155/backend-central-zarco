import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';

export interface WhatsappMessagePayload {
  customerId: string;
  text?: string;
  imageUrl?: string;
}

export interface WhatsappLocationRequestPayload {
  customerId: string;
  reason?: string;
}

export interface TelegramAlertPayload {
  chatRef: string;
  text: string;
  /** Si se pasa, el gateway edita el mensaje ya enviado en vez de crear uno nuevo. */
  editMessageId?: string;
  buttons?: Array<{ label: string; action: string }>;
}

export interface TelegramAlertResult {
  externalMessageId: string;
}

export interface WhatsappMessageResult {
  externalMessageId: string;
}

/**
 * Cliente HTTP hacia el "gateway API" de saas_smarky. El backend central
 * nunca sabe qué es WhatsApp/Kapso/Telegram — solo llama a estos tres
 * endpoints entrantes. Ver sección "API que saas_smarky expone" del plan.
 */
@Injectable()
export class GatewayClientService {
  private readonly logger = new Logger(GatewayClientService.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async sendWhatsappMessage(payload: WhatsappMessagePayload): Promise<WhatsappMessageResult> {
    return this.post<WhatsappMessageResult>('/gateway/whatsapp/messages', payload);
  }

  async requestWhatsappLocation(payload: WhatsappLocationRequestPayload): Promise<void> {
    await this.post('/gateway/whatsapp/location-requests', payload);
  }

  async sendTelegramAlert(payload: TelegramAlertPayload): Promise<TelegramAlertResult> {
    return this.post<TelegramAlertResult>('/gateway/telegram/alerts', payload);
  }

  private async post<T = void>(path: string, body: unknown): Promise<T> {
    const { baseUrl, authToken, timeoutMs } = this.config.get('gateway', { infer: true });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          throw new Error('Gateway request timed out');
        }
        throw new Error('Gateway request failed');
      }

      if (!response.ok) {
        this.logger.warn(`Gateway call failed: POST ${path} -> ${response.status}`);
        throw new Error(`Gateway call failed: POST ${path} -> ${response.status}`);
      }

      if (response.status === 204) {
        return undefined as T;
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

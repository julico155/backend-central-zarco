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

/**
 * Cliente HTTP hacia el "gateway API" de saas_smarky. El backend central
 * nunca sabe qué es WhatsApp/Kapso/Telegram — solo llama a estos tres
 * endpoints entrantes. Ver sección "API que saas_smarky expone" del plan.
 */
@Injectable()
export class GatewayClientService {
  private readonly logger = new Logger(GatewayClientService.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async sendWhatsappMessage(payload: WhatsappMessagePayload): Promise<void> {
    await this.post('/gateway/whatsapp/messages', payload);
  }

  async requestWhatsappLocation(payload: WhatsappLocationRequestPayload): Promise<void> {
    await this.post('/gateway/whatsapp/location-requests', payload);
  }

  async sendTelegramAlert(payload: TelegramAlertPayload): Promise<TelegramAlertResult> {
    return this.post<TelegramAlertResult>('/gateway/telegram/alerts', payload);
  }

  private async post<T = void>(path: string, body: unknown): Promise<T> {
    const { baseUrl, authToken } = this.config.get('gateway', { infer: true });
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      this.logger.warn(`Gateway call failed: POST ${path} -> ${response.status} ${text}`);
      throw new Error(`Gateway call failed: POST ${path} -> ${response.status}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}

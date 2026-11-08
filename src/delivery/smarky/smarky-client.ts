import { Logger } from '@nestjs/common';
import { SmarkyCreateDeliveryInput, SmarkyDeliveryCreated, SmarkyQuote } from './smarky.types';

const REQUEST_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

/** Error de la plataforma: `{ code, message, details }`. Se decide por `code`, nunca por el texto. */
export class SmarkyApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'SmarkyApiError';
  }

  /** Fallos pasajeros: se reintentan. Cualquier otro código es una respuesta definitiva. */
  get retryable(): boolean {
    if (this.code === 'tariff_not_configured') return false;
    return this.code === 'network_error' || this.code === 'routing_unavailable' || this.status >= 500;
  }
}

export interface SmarkyClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Cliente HTTP de la plataforma de reparto. La credencial nunca se escribe en logs. */
export class SmarkyClient {
  private readonly logger = new Logger(SmarkyClient.name);
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: SmarkyClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  createQuote(destination: { latitude: number; longitude: number }): Promise<SmarkyQuote> {
    return this.withRetry(() => this.request<SmarkyQuote>('/v1/cotizaciones', { destination }));
  }

  /** Idempotente por `externalOrderId`: reintentar tras un timeout no crea una segunda entrega. */
  createDelivery(input: SmarkyCreateDeliveryInput): Promise<SmarkyDeliveryCreated> {
    return this.withRetry(() => this.request<SmarkyDeliveryCreated>('/v1/entregas', input));
  }

  /** Emite un código nuevo (el anterior deja de servir). No es idempotente a propósito. */
  async reissueCode(deliveryId: string): Promise<string> {
    const body = await this.withRetry(() =>
      this.request<{ deliveryCode: string }>(`/v1/entregas/${deliveryId}/codigo`),
    );
    return body.deliveryCode;
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof SmarkyApiError) || !error.retryable || attempt >= MAX_ATTEMPTS) {
          throw error;
        }
        await this.sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const label = `POST ${path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id')}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchFn(`${this.options.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      this.logger.warn(`Plataforma de reparto inalcanzable: ${label} (${(error as Error).name})`);
      throw new SmarkyApiError(0, 'network_error', 'No se pudo contactar a la plataforma de reparto.');
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text().catch(() => '');
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const err = (parsed ?? {}) as { code?: string; message?: string; details?: Record<string, unknown> | null };
      const code = typeof err.code === 'string' ? err.code : `http_${response.status}`;
      this.logger.warn(`Plataforma de reparto: ${label} -> ${response.status} ${code}`);
      throw new SmarkyApiError(response.status, code, err.message ?? `HTTP ${response.status}`, err.details ?? null);
    }
    return parsed as T;
  }
}

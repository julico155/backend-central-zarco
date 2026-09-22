import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { CreateLogisticsDeliveryRequest } from './logistics-delivery.mapper';

export type LogisticsDeliveryDispatchResult =
  | { kind: 'succeeded'; deliveryId: string; remoteStatusCode: 201 | 409 }
  | {
      kind: 'retryable_failure';
      errorCode: 'timeout' | 'network_error' | 'rate_limited' | 'remote_server_error';
      remoteStatusCode: number | null;
      retryAfterMs?: number;
    }
  | { kind: 'permanent_failure'; errorCode: string; remoteStatusCode: number | null };

@Injectable()
export class LogisticsHttpClientService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async createDelivery(
    payload: CreateLogisticsDeliveryRequest,
  ): Promise<LogisticsDeliveryDispatchResult> {
    const logistics = this.config.get('logisticsDispatch', { infer: true });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), logistics.requestTimeoutMs);

    try {
      const response = await fetch(`${logistics.baseUrl.replace(/\/$/, '')}/v1/deliveries`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${logistics.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      return await classifyResponse(response);
    } catch (error) {
      if (controller.signal.aborted || (error as { name?: string }).name === 'AbortError') {
        return { kind: 'retryable_failure', errorCode: 'timeout', remoteStatusCode: null };
      }
      return { kind: 'retryable_failure', errorCode: 'network_error', remoteStatusCode: null };
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function classifyResponse(response: Response): Promise<LogisticsDeliveryDispatchResult> {
  if (response.status === 201) {
    const body = await parseJson(response);
    const deliveryId = body?.id;
    if (typeof deliveryId === 'string' && isUuid(deliveryId)) {
      return { kind: 'succeeded', deliveryId, remoteStatusCode: 201 };
    }
    return {
      kind: 'permanent_failure',
      errorCode: 'invalid_success_response',
      remoteStatusCode: 201,
    };
  }

  if (response.status === 409) {
    const body = await parseJson(response);
    if (
      body?.code === 'delivery_already_exists' &&
      typeof body.deliveryId === 'string' &&
      isUuid(body.deliveryId)
    ) {
      return { kind: 'succeeded', deliveryId: body.deliveryId, remoteStatusCode: 409 };
    }
    return { kind: 'permanent_failure', errorCode: 'conflict', remoteStatusCode: 409 };
  }

  if (response.status === 429) {
    return {
      kind: 'retryable_failure',
      errorCode: 'rate_limited',
      remoteStatusCode: 429,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    };
  }

  if (response.status >= 500 && response.status <= 599) {
    return {
      kind: 'retryable_failure',
      errorCode: 'remote_server_error',
      remoteStatusCode: response.status,
    };
  }

  if (response.status >= 200 && response.status <= 299) {
    return {
      kind: 'permanent_failure',
      errorCode: 'unexpected_success_status',
      remoteStatusCode: response.status,
    };
  }

  return {
    kind: 'permanent_failure',
    errorCode: 'remote_client_error',
    remoteStatusCode: response.status,
  };
}

async function parseJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

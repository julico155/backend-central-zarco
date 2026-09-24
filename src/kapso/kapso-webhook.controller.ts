import { Controller, Headers, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AppConfig } from '../config/configuration';
import { WebhookInboxService } from '../webhook-inbox/webhook-inbox.service';
import { buildNormalizedEvents, parseKapsoEnvelopes } from './kapso-normalizer';
import { verifyKapsoSignature } from './kapso-signature';
import { KAPSO_PAYLOAD_VERSION, KAPSO_SUPPORTED_EVENT, isKapsoAcceptedEvent } from './kapso.types';

type RawBodyRequest = Request & { rawBody?: Buffer };

@Controller('kapso')
export class KapsoWebhookController {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly inbox: WebhookInboxService,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest,
    @Res({ passthrough: true }) response: Response,
    @Headers('x-webhook-signature') signature: string | undefined,
    @Headers('x-webhook-payload-version') version: string | undefined,
    @Headers('x-webhook-event') eventName: string | undefined,
    @Headers('x-idempotency-key') eventId: string | undefined,
  ): Promise<Record<string, unknown>> {
    const rawBody = request.rawBody;
    const kapso = this.config.get('kapso', { infer: true });
    if (!rawBody || !verifyKapsoSignature(rawBody, signature, kapso.webhookSecret)) {
      response.status(401);
      return { error: 'invalid_signature' };
    }
    if (version !== KAPSO_PAYLOAD_VERSION) {
      response.status(400);
      return { error: 'unsupported_version' };
    }

    const rawText = rawBody.toString('utf8');
    const parsed = parseKapsoEnvelopes(rawText);
    if (!parsed.ok) {
      response.status(parsed.status);
      return {
        ok: false,
        error: parsed.error,
        ...(parsed.reason ? { reason: parsed.reason } : {}),
      };
    }
    if (!isKapsoAcceptedEvent(eventName)) return { ok: true, ignored: true };
    if (parsed.batched && eventName !== KAPSO_SUPPORTED_EVENT) {
      response.status(422);
      return { ok: false, error: 'unsupported_batch', reason: 'batch_unsupported_event' };
    }
    if (!eventId?.trim()) {
      response.status(400);
      return { error: 'missing_idempotency_key' };
    }

    const events = buildNormalizedEvents(parsed.envelopes, eventName, eventId);
    const messageId = events[events.length - 1]?.messageId ?? null;
    const accepted = await this.inbox.accept({
      eventId,
      eventName,
      messageId,
      payload: JSON.parse(rawText),
    });
    if (accepted.kind === 'duplicate') return { ok: true, duplicate: true };
    if (accepted.kind === 'in_progress') return { ok: true, in_progress: true };

    if (this.config.get('webhookAsyncAck', { infer: true })) {
      setImmediate(() => {
        void this.inbox.processById(accepted.id);
      });
      return { ok: true, accepted: true };
    }
    await this.inbox.processById(accepted.id);
    return { ok: true, accepted: true };
  }
}

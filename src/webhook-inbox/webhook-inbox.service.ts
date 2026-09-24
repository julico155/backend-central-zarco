import { Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { normalizeKapsoPayload } from '../kapso/kapso-normalizer';
import { WebhookAcceptResult, WebhookEventRow } from './webhook-inbox.types';
import { WebhookInboxDispatcher } from './webhook-inbox.dispatcher';

export const WEBHOOK_MAX_ATTEMPTS = 5;
export const WEBHOOK_LEASE_SECONDS = 90;
export const WEBHOOK_RECOVERY_BATCH_SIZE = 3;
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 120_000] as const;

export interface AcceptWebhookEventInput {
  eventId: string;
  eventName: string;
  messageId: string | null;
  payload: unknown;
}

function retryDelayMs(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1)];
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'dispatch_timeout';
  return 'dispatch_failed';
}

/** Durable, claim-based inbox for authenticated Kapso deliveries. */
@Injectable()
export class WebhookInboxService {
  private readonly logger = new Logger(WebhookInboxService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly dispatcher: WebhookInboxDispatcher,
  ) {}

  async accept(input: AcceptWebhookEventInput): Promise<WebhookAcceptResult> {
    const inserted = await this.db
      .insertInto('webhook_events')
      .values({
        event_id: input.eventId,
        event_name: input.eventName,
        message_id: input.messageId,
        payload: JSON.stringify(input.payload),
        status: 'received',
        next_attempt_at: new Date(),
        max_attempts: WEBHOOK_MAX_ATTEMPTS,
      })
      .onConflict((oc) => oc.column('event_id').doNothing())
      .returning('id')
      .executeTakeFirst();

    if (inserted) return { kind: 'accepted', id: inserted.id };

    const existing = await this.db
      .selectFrom('webhook_events')
      .select(['id', 'status'])
      .where('event_id', '=', input.eventId)
      .executeTakeFirstOrThrow();

    if (existing.status === 'processed') return { kind: 'duplicate' };
    if (existing.status === 'processing') return { kind: 'in_progress' };
    if (existing.status === 'received') return { kind: 'accepted', id: existing.id };

    // A provider redelivery is a new opportunity for a previously exhausted
    // delivery. This CAS prevents it from reopening an event another worker won.
    const reopened = await this.db
      .updateTable('webhook_events')
      .set({
        status: 'received',
        next_attempt_at: new Date(),
        error_message: null,
        claim_token: null,
        claimed_until: null,
        updated_at: new Date(),
      })
      .where('id', '=', existing.id)
      .where('status', '=', 'failed')
      .returning('id')
      .executeTakeFirst();
    return reopened ? { kind: 'accepted', id: reopened.id } : { kind: 'in_progress' };
  }

  /** Fast-path claim. Only one caller receives a row and may dispatch it. */
  async processById(id: string): Promise<'processed' | 'not_claimed' | 'failed'> {
    const claimed = await this.claimById(id);
    if (!claimed) return 'not_claimed';
    return this.processClaimed(claimed);
  }

  async recoverDue(
    batchSize = WEBHOOK_RECOVERY_BATCH_SIZE,
  ): Promise<{ claimed: number; processed: number; failed: number }> {
    let claimed = 0;
    let processed = 0;
    let failed = 0;
    for (let index = 0; index < batchSize; index += 1) {
      // Claim one immediately before work: later rows never wait in memory
      // behind a valid lease held by an earlier row.
      const row = await this.claimNextRecoverable();
      if (!row) break;
      claimed += 1;
      const result = await this.processClaimed(row);
      if (result === 'processed') processed += 1;
      else failed += 1;
    }
    return { claimed, processed, failed };
  }

  private async claimById(id: string): Promise<WebhookEventRow | undefined> {
    const claimToken = randomUUID();
    const result = await sql<WebhookEventRow>`
      update webhook_events
      set status = 'processing',
          claim_token = ${claimToken}::uuid,
          claimed_until = now() + (${WEBHOOK_LEASE_SECONDS} * interval '1 second'),
          attempts = attempts + 1,
          error_message = null,
          updated_at = now()
      where id = ${id}::uuid
        and status = 'received'
      returning id, event_name, event_id, payload, attempts, max_attempts, claim_token
    `.execute(this.db);
    return result.rows[0];
  }

  private async claimNextRecoverable(): Promise<WebhookEventRow | undefined> {
    const claimToken = randomUUID();
    const result = await sql<WebhookEventRow>`
      with claimable as (
        select id
        from webhook_events
        where attempts < max_attempts
          and (
            (status = 'received' and (next_attempt_at is null or next_attempt_at <= now()))
            or (status = 'processing' and claimed_until is not null and claimed_until <= now())
          )
        order by created_at asc
        limit 1
        for update skip locked
      )
      update webhook_events events
      set status = 'processing',
          claim_token = ${claimToken}::uuid,
          claimed_until = now() + (${WEBHOOK_LEASE_SECONDS} * interval '1 second'),
          attempts = events.attempts + 1,
          error_message = null,
          updated_at = now()
      from claimable
      where events.id = claimable.id
      returning events.id, events.event_name, events.event_id, events.payload,
                events.attempts, events.max_attempts, events.claim_token
    `.execute(this.db);
    return result.rows[0];
  }

  private async processClaimed(row: WebhookEventRow): Promise<'processed' | 'failed'> {
    try {
      const normalized = normalizeKapsoPayload(
        JSON.stringify(row.payload),
        row.event_name,
        row.event_id,
      );
      if (!normalized.ok) throw new Error('durable_payload_invalid');
      await this.dispatcher.dispatch({
        id: row.id,
        eventId: row.event_id,
        eventName: row.event_name,
        payload: row.payload,
        normalizedEvents: normalized.events,
      });
      await this.markProcessed(row.id, row.claim_token);
      return 'processed';
    } catch (error) {
      this.logger.warn(`Webhook event ${row.id} dispatch failed: ${safeErrorCode(error)}`);
      await this.releaseAfterFailure(
        row.id,
        row.claim_token,
        row.attempts,
        row.max_attempts,
        error,
      );
      return 'failed';
    }
  }

  private async markProcessed(id: string, claimToken: string): Promise<void> {
    await sql`
      update webhook_events
      set status = 'processed',
          processed_at = now(),
          next_attempt_at = null,
          error_message = null,
          claim_token = null,
          claimed_until = null,
          updated_at = now()
      where id = ${id}::uuid and claim_token = ${claimToken}::uuid
    `.execute(this.db);
  }

  private async releaseAfterFailure(
    id: string,
    claimToken: string,
    attempts: number,
    maxAttempts: number,
    error: unknown,
  ): Promise<void> {
    const exhausted = attempts >= maxAttempts;
    const nextDelay = retryDelayMs(attempts);
    await sql`
      update webhook_events
      set status = ${exhausted ? 'failed' : 'received'},
          next_attempt_at = ${exhausted ? null : sql`now() + (${nextDelay} * interval '1 millisecond')`},
          error_message = ${safeErrorCode(error)},
          claim_token = null,
          claimed_until = null,
          updated_at = now()
      where id = ${id}::uuid and claim_token = ${claimToken}::uuid
    `.execute(this.db);
  }
}

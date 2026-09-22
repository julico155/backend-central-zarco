import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../config/configuration';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { CreateLogisticsDeliveryRequest } from './logistics-delivery.mapper';
import {
  LogisticsDeliveryDispatchResult,
  LogisticsHttpClientService,
} from './logistics-http-client.service';

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const LEASE_MS = 5 * 60_000;
const DEFAULT_BATCH_SIZE = 20;

interface ClaimedLogisticsDispatchJob {
  id: string;
  claimToken: string;
  attempts: number;
  payload: CreateLogisticsDeliveryRequest;
}

@Injectable()
export class LogisticsDispatchWorkerService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly client: LogisticsHttpClientService,
  ) {}

  async dispatchPending(
    batchSize = DEFAULT_BATCH_SIZE,
  ): Promise<{ claimed: number; recovered: number }> {
    if (!this.isEnabled()) return { claimed: 0, recovered: 0 };

    const recovered = await this.recoverExpiredLeases();
    const claimed = await this.claimPendingJobs(batchSize);
    for (const job of claimed) {
      await this.dispatchClaimedJob(job);
    }
    return { claimed: claimed.length, recovered };
  }

  async recoverExpiredLeases(): Promise<number> {
    if (!this.isEnabled()) return 0;
    const result = await this.db
      .updateTable('logistics_dispatch_jobs')
      .set({
        status: 'pending',
        claim_token: null,
        claimed_until: null,
        updated_at: new Date(),
      })
      .where('status', '=', 'sending')
      .where('claimed_until', '<', sql<Date>`now()`)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  private async claimPendingJobs(batchSize: number): Promise<ClaimedLogisticsDispatchJob[]> {
    return this.db.transaction().execute(async (trx) => {
      const candidates = await trx
        .selectFrom('logistics_dispatch_jobs')
        .select(['id', 'attempts', 'payload'])
        .where('status', '=', 'pending')
        .where('attempts', '<', MAX_ATTEMPTS)
        .where('next_attempt_at', '<=', sql<Date>`now()`)
        .orderBy('next_attempt_at', 'asc')
        .orderBy('created_at', 'asc')
        .limit(batchSize)
        .forUpdate()
        .skipLocked()
        .execute();

      const leaseUntil = new Date(Date.now() + LEASE_MS);
      const claimed: ClaimedLogisticsDispatchJob[] = [];
      for (const candidate of candidates) {
        const claimToken = randomUUID();
        const updated = await trx
          .updateTable('logistics_dispatch_jobs')
          .set({
            status: 'sending',
            attempts: (eb) => eb('attempts', '+', 1),
            claim_token: claimToken,
            claimed_until: leaseUntil,
            updated_at: new Date(),
          })
          .where('id', '=', candidate.id)
          .where('status', '=', 'pending')
          .returning(['id', 'attempts', 'payload', 'claim_token'])
          .executeTakeFirst();
        if (updated?.claim_token) {
          claimed.push({
            id: updated.id,
            claimToken: updated.claim_token,
            attempts: updated.attempts,
            payload: updated.payload as unknown as CreateLogisticsDeliveryRequest,
          });
        }
      }
      return claimed;
    });
  }

  private async dispatchClaimedJob(job: ClaimedLogisticsDispatchJob): Promise<void> {
    const result = await this.client.createDelivery(job.payload);
    if (result.kind === 'succeeded') {
      await this.markSucceeded(job, result);
      return;
    }
    if (result.kind === 'permanent_failure') {
      await this.markFailed(job, result.errorCode, result.remoteStatusCode);
      return;
    }
    await this.scheduleRetry(job, result);
  }

  private async markSucceeded(
    job: ClaimedLogisticsDispatchJob,
    result: Extract<LogisticsDeliveryDispatchResult, { kind: 'succeeded' }>,
  ): Promise<void> {
    await this.claimedUpdate(job)
      .set({
        status: 'succeeded',
        logistics_delivery_id: result.deliveryId,
        remote_status_code: result.remoteStatusCode,
        completed_at: new Date(),
        claim_token: null,
        claimed_until: null,
        last_error_code: null,
        updated_at: new Date(),
      })
      .execute();
  }

  private async markFailed(
    job: ClaimedLogisticsDispatchJob,
    errorCode: string,
    remoteStatusCode: number | null,
  ): Promise<void> {
    await this.claimedUpdate(job)
      .set({
        status: 'failed',
        remote_status_code: remoteStatusCode,
        claim_token: null,
        claimed_until: null,
        last_error_code: errorCode,
        updated_at: new Date(),
      })
      .execute();
  }

  private async scheduleRetry(
    job: ClaimedLogisticsDispatchJob,
    result: Extract<LogisticsDeliveryDispatchResult, { kind: 'retryable_failure' }>,
  ): Promise<void> {
    if (job.attempts >= MAX_ATTEMPTS) {
      await this.markFailed(job, 'max_attempts_exceeded', result.remoteStatusCode);
      return;
    }

    const backoffMs = Math.min(BASE_BACKOFF_MS * 2 ** (job.attempts - 1), MAX_BACKOFF_MS);
    const retryAfterMs = result.retryAfterMs === undefined ? 0 : result.retryAfterMs;
    const delayMs = Math.min(Math.max(backoffMs, retryAfterMs), MAX_BACKOFF_MS);
    await this.claimedUpdate(job)
      .set({
        status: 'pending',
        next_attempt_at: new Date(Date.now() + delayMs),
        remote_status_code: result.remoteStatusCode,
        claim_token: null,
        claimed_until: null,
        last_error_code: result.errorCode,
        updated_at: new Date(),
      })
      .execute();
  }

  private claimedUpdate(job: ClaimedLogisticsDispatchJob) {
    return this.db
      .updateTable('logistics_dispatch_jobs')
      .where('id', '=', job.id)
      .where('status', '=', 'sending')
      .where('claim_token', '=', job.claimToken);
  }

  private isEnabled(): boolean {
    return this.config.get('logisticsDispatch', { infer: true }).enabled;
  }
}

export const logisticsDispatchPolicy = {
  maxAttempts: MAX_ATTEMPTS,
  baseBackoffMs: BASE_BACKOFF_MS,
  maxBackoffMs: MAX_BACKOFF_MS,
  leaseMs: LEASE_MS,
};

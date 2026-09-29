import { Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { GatewayClientService } from '../gateway-client/gateway-client.service';
import {
  TelegramAlertPayload,
  WhatsappLocationRequestPayload,
  WhatsappMessagePayload,
} from '../gateway-client/gateway-client.service';
import { NotificationJobPayload } from './notification-job.types';

const MAX_ATTEMPTS = 8;
const RECOVERY_BATCH_SIZE = 20;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

interface ClaimedJobRow {
  id: string;
  kind: string;
  channel: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Reemplaza order_notifications + telegram_alerts con una tabla única de
 * "trabajos de aviso". Camino rápido: la misma llamada que decide el cambio
 * de estado intenta el envío inmediatamente. Camino de recuperación:
 * `recoverFailedJobs` (invocado por NotificationRecoveryCron cada minuto)
 * reclama con `FOR UPDATE SKIP LOCKED` lo que quedó 'pending'/'failed' y
 * reintenta con backoff exponencial, usando idx_notification_jobs_claimable.
 */
@Injectable()
export class NotificationsOutService {
  private readonly logger = new Logger(NotificationsOutService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly gateway: GatewayClientService,
  ) {}

  /** Encola el trabajo (dedupe por kind+target_ref) e intenta enviarlo ya. */
  async notifyNow(job: NotificationJobPayload): Promise<void> {
    const id = await this.enqueue(job);
    const attempts = await this.claimForFastPath(id);
    if (attempts === null) return;
    await this.dispatch(id, job.channel, job.kind, job.payload as unknown as Record<string, unknown>, attempts);
  }

  /**
   * Camino de recuperación: reclama hasta `batchSize` jobs pendientes/
   * fallidos cuyo `next_attempt_at` ya venció (o nunca se fijó) y no
   * superaron MAX_ATTEMPTS, y reintenta cada uno. `FOR UPDATE SKIP LOCKED`
   * hace esto seguro incluso con más de una instancia del backend corriendo
   * el cron a la vez.
   */
  async recoverFailedJobs(batchSize = RECOVERY_BATCH_SIZE): Promise<{ claimed: number }> {
    const claimed = await sql<ClaimedJobRow>`
      update notification_jobs
      set status = 'sending', attempts = attempts + 1, updated_at = now()
      where id in (
        select id from notification_jobs
        where status in ('pending', 'failed')
          and attempts < ${MAX_ATTEMPTS}
          and (next_attempt_at is null or next_attempt_at <= now())
        order by created_at asc
        limit ${batchSize}
        for update skip locked
      )
      returning id, kind, channel, payload, attempts
    `.execute(this.db);

    for (const row of claimed.rows) {
      await this.dispatch(row.id, row.channel, row.kind, row.payload, row.attempts);
    }
    return { claimed: claimed.rows.length };
  }

  private async enqueue(job: NotificationJobPayload): Promise<string> {
    const inserted = await this.db
      .insertInto('notification_jobs')
      .values({
        kind: job.kind,
        channel: job.channel,
        target_ref: job.targetRef,
        payload: JSON.stringify(job.payload),
      })
      .onConflict((oc) => oc.columns(['kind', 'target_ref']).doNothing())
      .returning('id')
      .executeTakeFirst();

    if (inserted) return inserted.id;

    const existing = await this.db
      .selectFrom('notification_jobs')
      .select('id')
      .where('kind', '=', job.kind)
      .where('target_ref', '=', job.targetRef)
      .executeTakeFirstOrThrow();
    return existing.id;
  }

  /**
   * Solo quien cambia pending|failed -> sending puede hacer el envío rápido.
   * Si el job ya está sent o otra instancia lo está enviando, no se reenvía.
   */
  private async claimForFastPath(id: string): Promise<number | null> {
    const claimed = await this.db
      .updateTable('notification_jobs')
      .set({ status: 'sending', attempts: (eb) => eb('attempts', '+', 1), updated_at: new Date() })
      .where('id', '=', id)
      .where('status', 'in', ['pending', 'failed'])
      .where('attempts', '<', MAX_ATTEMPTS)
      .where((eb) =>
        eb.or([eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', sql<Date>`now()`)]),
      )
      .returning('attempts')
      .executeTakeFirst();
    return claimed?.attempts ?? null;
  }

  /**
   * Siempre recibe el contador posterior al claim. El camino rápido y el de
   * recovery reclaman antes de llamar a este método; así no existe una ruta
   * que pueda entregar una fila ya sent o tomada por otra instancia.
   */
  private async dispatch(
    id: string,
    channel: string,
    kind: string,
    payload: Record<string, unknown>,
    attemptsAfterClaim: number,
  ): Promise<void> {
    try {
      const externalMessageId = await this.send(channel, kind, payload);
      await this.db
        .updateTable('notification_jobs')
        .set({ status: 'sent', external_message_id: externalMessageId ?? null })
        .where('id', '=', id)
        .execute();
    } catch (error) {
      this.logger.warn(`Notification job ${id} failed: ${(error as Error).message}`);
      const backoffMs = Math.min(BASE_BACKOFF_MS * 2 ** (attemptsAfterClaim - 1), MAX_BACKOFF_MS);
      await this.db
        .updateTable('notification_jobs')
        .set({
          status: 'failed',
          last_error_code:
            attemptsAfterClaim >= MAX_ATTEMPTS ? 'max_attempts_exceeded' : 'gateway_error',
          next_attempt_at: new Date(Date.now() + backoffMs),
        })
        .where('id', '=', id)
        .execute();
    }
  }

  private async send(
    channel: string,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<string | undefined> {
    if (channel === 'telegram') {
      const result = await this.gateway.sendTelegramAlert(payload as unknown as TelegramAlertPayload);
      return result.externalMessageId;
    }
    if (kind === 'location_request') {
      await this.gateway.requestWhatsappLocation(payload as unknown as WhatsappLocationRequestPayload);
      return undefined;
    }
    const result = await this.gateway.sendWhatsappMessage(payload as unknown as WhatsappMessagePayload);
    return result.externalMessageId;
  }
}

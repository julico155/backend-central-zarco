import { Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { GatewayClientService } from '../gateway-client/gateway-client.service';
import { NotificationJobPayload } from './notification-job.types';

/**
 * Reemplaza order_notifications + telegram_alerts con una tabla única de
 * "trabajos de aviso". Camino rápido: la misma llamada que decide el cambio
 * de estado intenta el envío inmediatamente. Camino de recuperación: un job
 * de barrido reintenta lo que falló (TODO fase de implementación: cron
 * propio con backoff sobre notification_jobs.status in ('pending','failed'),
 * usando idx_notification_jobs_claimable — ver migración
 * 1700000010000_notification-jobs).
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
    await this.dispatch(id, job);
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

  private async dispatch(id: string, job: NotificationJobPayload): Promise<void> {
    await this.db
      .updateTable('notification_jobs')
      .set({ status: 'sending', attempts: (eb) => eb('attempts', '+', 1) })
      .where('id', '=', id)
      .where('status', 'in', ['pending', 'failed'])
      .execute();

    try {
      const externalMessageId = await this.send(job);
      await this.db
        .updateTable('notification_jobs')
        .set({ status: 'sent', external_message_id: externalMessageId ?? null })
        .where('id', '=', id)
        .execute();
    } catch (error) {
      this.logger.warn(`Notification job ${id} failed: ${(error as Error).message}`);
      await this.db
        .updateTable('notification_jobs')
        .set({
          status: 'failed',
          last_error_code: 'gateway_error',
          // Backoff simple; el job de recuperación decide la próxima ventana real.
          next_attempt_at: new Date(Date.now() + 60_000),
        })
        .where('id', '=', id)
        .execute();
    }
  }

  private async send(job: NotificationJobPayload): Promise<string | undefined> {
    if (job.channel === 'telegram') {
      const result = await this.gateway.sendTelegramAlert(job.payload);
      return result.externalMessageId;
    }
    if (job.kind === 'location_request') {
      await this.gateway.requestWhatsappLocation(job.payload as never);
      return undefined;
    }
    const result = await this.gateway.sendWhatsappMessage(job.payload as never);
    return result.externalMessageId;
  }
}

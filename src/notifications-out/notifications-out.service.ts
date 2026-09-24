import { Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { KapsoOutboundService } from '../kapso/kapso-outbound.service';
import { TelegramService } from '../telegram/telegram.service';
import type {
  TelegramAlertPayload,
  WhatsappLocationRequestPayload,
  WhatsappMessagePayload,
} from '../gateway-client/gateway-client.service';
import { NotificationJobPayload } from './notification-job.types';

const MAX_ATTEMPTS = 8;
const RECOVERY_BATCH_SIZE = 20;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const CLAIM_LEASE_SECONDS = 5 * 60;

interface ClaimedJobRow {
  id: string;
  kind: string;
  channel: string;
  payload: Record<string, unknown>;
  attempts: number;
  claim_token: string;
}

/**
 * Reemplaza order_notifications + telegram_alerts con una tabla única de
 * "trabajos de aviso". Camino rápido: la misma llamada que decide el cambio
 * de estado intenta el envío inmediatamente. Camino de recuperación:
 * `recoverFailedJobs` (invocado por NotificationRecoveryCron cada minuto)
 * reclama con `FOR UPDATE SKIP LOCKED` lo que quedó 'pending'/'failed' o una
 * ejecución `sending` cuyo lease venció. Un claim tiene dueño (`claim_token`):
 * solo ese dueño puede cerrar el intento.
 */
@Injectable()
export class NotificationsOutService {
  private readonly logger = new Logger(NotificationsOutService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly telegram: TelegramService,
    private readonly kapso: KapsoOutboundService,
  ) {}

  /** Encola el trabajo (dedupe por kind+target_ref) e intenta enviarlo ya. */
  async notifyNow(job: NotificationJobPayload): Promise<void> {
    const id = await this.enqueue(job);
    const claimed = await this.claimById(id);
    if (claimed) await this.dispatch(claimed);
  }

  /**
   * Camino de recuperación: reclama y despacha un job por vez, hasta
   * `batchSize`. El lease empieza inmediatamente antes de `dispatch`, evitando
   * que un job espere en memoria durante los envíos secuenciales previos.
   */
  async recoverFailedJobs(batchSize = RECOVERY_BATCH_SIZE): Promise<{ claimed: number }> {
    let claimed = 0;
    for (let index = 0; index < batchSize; index += 1) {
      const job = await this.claimNextRecoverable();
      if (!job) break;
      claimed += 1;
      await this.dispatch(job);
    }
    return { claimed };
  }

  /** Reclamo atómico de una sola fila para que su lease no haga cola. */
  private async claimNextRecoverable(): Promise<ClaimedJobRow | undefined> {
    const result = await sql<ClaimedJobRow>`
      with claimable as (
        select id
        from notification_jobs
        where attempts < ${MAX_ATTEMPTS}
          and (
            (status in ('pending', 'failed')
              and (next_attempt_at is null or next_attempt_at <= now()))
            or (status = 'sending'
              and claimed_until is not null
              and claimed_until <= now())
          )
        order by created_at asc
        limit 1
        for update skip locked
      )
      update notification_jobs jobs
      set status = 'sending',
          claim_token = gen_random_uuid(),
          claimed_until = now() + (${CLAIM_LEASE_SECONDS} * interval '1 second'),
          attempts = jobs.attempts + 1,
          updated_at = now()
      from claimable
      where jobs.id = claimable.id
      returning jobs.id, jobs.kind, jobs.channel, jobs.payload, jobs.attempts, jobs.claim_token
    `.execute(this.db);

    return result.rows[0];
  }

  /**
   * Claim del fast path. Si el job ya está sent, sending o agotó sus intentos,
   * no devuelve fila y por tanto no hay llamada al proveedor.
   */
  private async claimById(id: string): Promise<ClaimedJobRow | undefined> {
    const result = await sql<ClaimedJobRow>`
      update notification_jobs
      set status = 'sending',
          claim_token = gen_random_uuid(),
          claimed_until = now() + (${CLAIM_LEASE_SECONDS} * interval '1 second'),
          attempts = attempts + 1,
          updated_at = now()
      where id = ${id}
        and attempts < ${MAX_ATTEMPTS}
        and status in ('pending', 'failed')
        and (next_attempt_at is null or next_attempt_at <= now())
      returning id, kind, channel, payload, attempts, claim_token
    `.execute(this.db);
    return result.rows[0];
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

  private async dispatch(job: ClaimedJobRow): Promise<void> {
    // The lease guarantees one active emitter at a time. It cannot make the
    // provider interaction exactly-once: a process can die after the provider
    // accepts the message and before this process persists `sent`.
    try {
      const externalMessageId = await this.send(job.channel, job.kind, job.payload);
      await this.markSent(job.id, job.claim_token, externalMessageId);
    } catch (error) {
      this.logger.warn(`Notification job ${job.id} failed: ${(error as Error).message}`);
      await this.markFailed(job.id, job.claim_token, job.attempts);
    }
  }

  /** Solo el dueño del lease puede confirmar un envío. */
  private async markSent(
    id: string,
    claimToken: string,
    externalMessageId: string | undefined,
  ): Promise<void> {
    await sql`
      update notification_jobs
      set status = 'sent',
          external_message_id = ${externalMessageId ?? null},
          last_error_code = null,
          next_attempt_at = null,
          claim_token = null,
          claimed_until = null,
          updated_at = now()
      where id = ${id}
        and claim_token = ${claimToken}::uuid
    `.execute(this.db);
  }

  /** Solo el dueño del lease puede programar el siguiente intento. */
  private async markFailed(id: string, claimToken: string, attempts: number): Promise<void> {
    const backoffMs = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
    await sql`
      update notification_jobs
      set status = 'failed',
          last_error_code = ${attempts >= MAX_ATTEMPTS ? 'max_attempts_exceeded' : 'gateway_error'},
          next_attempt_at = now() + (${backoffMs} * interval '1 millisecond'),
          claim_token = null,
          claimed_until = null,
          updated_at = now()
      where id = ${id}
        and claim_token = ${claimToken}::uuid
    `.execute(this.db);
  }

  /**
   * Transportes DIRECTOS (sin pasar por el gateway HTTP de sarcoRestaurant):
   * Telegram → TelegramService, WhatsApp → KapsoOutboundService. Un fallo
   * lanza y `dispatch` lo convierte en reintento con backoff.
   */
  private async send(
    channel: string,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<string | undefined> {
    if (channel === 'telegram') {
      const alert = payload as unknown as TelegramAlertPayload;
      // `buttons` se ignora a propósito: no hay callback_query ni webhook de
      // Telegram, y el gateway anterior rechazaba cualquier mensaje con botones.
      const result = await this.telegram.send({
        chatRef: alert.chatRef,
        text: alert.text,
        parseMode: alert.parseMode,
        editMessageId: alert.editMessageId,
      });
      if (!result.ok)
        throw new Error(`telegram_${result.error}${result.status ? `_${result.status}` : ''}`);
      return result.messageId;
    }

    if (kind === 'location_request') {
      const request = payload as unknown as WhatsappLocationRequestPayload;
      const phone = await this.customerPhone(request.customerId);
      const sent = await this.kapso.sendLocationRequest(phone);
      if (!sent.ok) throw new Error(`kapso_${sent.error}${sent.status ? `_${sent.status}` : ''}`);
      return sent.wamid;
    }

    const message = payload as unknown as WhatsappMessagePayload;
    const phone = await this.customerPhone(message.customerId);
    if (message.imageUrl === undefined) {
      const sent = await this.kapso.sendText(phone, message.text ?? '');
      if (!sent.ok) throw new Error(`kapso_${sent.error}${sent.status ? `_${sent.status}` : ''}`);
      return sent.wamid;
    }

    const image = await this.loadImage(message.imageUrl);
    const uploaded = await this.kapso.uploadImage(image.bytes, image.mimeType);
    if (!uploaded.ok) throw new Error(`kapso_upload_${uploaded.error}`);
    const sent = await this.kapso.sendImageByMediaId(phone, uploaded.mediaId, message.text);
    if (!sent.ok) throw new Error(`kapso_${sent.error}${sent.status ? `_${sent.status}` : ''}`);
    return sent.wamid;
  }

  private async customerPhone(customerId: string): Promise<string> {
    const customer = await this.db
      .selectFrom('customers')
      .select('phone')
      .where('id', '=', customerId)
      .executeTakeFirst();
    const phone = customer?.phone?.trim();
    if (!phone) throw new Error('customer_phone_unavailable');
    return phone;
  }

  /** Único tipo de imagen interna que se manda por WhatsApp hoy: el QR del banco (`/orders/:id/qr-image`). */
  private async loadImage(imageUrl: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const match = /^\/orders\/([0-9a-f-]{36})\/qr-image$/i.exec(imageUrl);
    if (!match) throw new Error('unsupported_image_url');
    const charge = await this.db
      .selectFrom('bank_qr_charges')
      .select('qr_image_base64')
      .where('order_id', '=', match[1])
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    if (!charge) throw new Error('image_not_found');
    return { bytes: Buffer.from(charge.qr_image_base64, 'base64'), mimeType: 'image/png' };
  }
}

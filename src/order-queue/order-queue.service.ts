import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { DomainException } from '../common/exceptions/domain-exception';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { NotificationsOutService } from '../notifications-out/notifications-out.service';
import { OperationalSettingsService } from '../operational-settings/operational-settings.service';
import {
  ADMISSION_TTL_MS,
  canAdmitDirectly,
  freeSlots,
  queueReadyText,
  RECENTLY_USED_GRACE_MS,
  releaseCount,
  shouldSendReminder,
  WAITING_TTL_MS,
} from './order-queue.rules';

export interface AdmissionResult {
  /** `true` = puede hacer su pedido ahora (se le reservó un cupo). */
  admitted: boolean;
  /** Lugar en la fila (1 = el próximo). `null` si está admitido. */
  position: number | null;
  /** `true` solo la primera vez que entra a la fila: es cuando hay que avisarle "estamos saturados". */
  firstTime: boolean;
}

export interface QueueSummary {
  enabled: boolean;
  /** Pedidos que hoy ocupan la cocina (confirmado, preparando, listo). */
  kitchenLoad: number;
  capacity: number;
  /** Clientes avisados que todavía no hicieron su pedido (cupos prometidos). */
  reserved: number;
  waiting: number;
}

/** El cliente tiene que esperar su turno: la cocina está llena y la cola está activa. */
export class QueueWaitingError extends DomainException {
  constructor() {
    super(
      'queue_waiting',
      HttpStatus.CONFLICT,
      'Estamos saturados en este momento. Te avisaremos por WhatsApp apenas puedas hacer tu pedido.',
    );
  }
}

/** Canales de cliente: el mostrador (pos) nunca pasa por la fila. */
const QUEUED_CHANNELS = new Set(['whatsapp', 'web']);

/**
 * Cola de pedidos. Cuando está activa y la cocina se llena (capacidad configurable), los clientes nuevos esperan en
 * una fila y se les avisa por WhatsApp, en tandas, cuando se liberan cupos. Un pedido ocupa cocina mientras esté
 * confirmado, preparando o listo; al salir "en camino" (lo marca el tracking del reparto) libera su cupo.
 *
 * Todo lo que decide quién entra pasa por un lock de Postgres (`pg_advisory_xact_lock`): sin él, dos clientes que
 * piden el menú en el mismo segundo podrían quedarse con el mismo último cupo.
 */
@Injectable()
export class OrderQueueService {
  private readonly logger = new Logger(OrderQueueService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly settings: OperationalSettingsService,
    private readonly notifications: NotificationsOutService,
  ) {}

  /** El cliente pide el menú (o intenta pedir): ¿puede pasar o espera? Crea su lugar en la fila si hace falta. */
  async requestAdmission(customerId: string): Promise<AdmissionResult> {
    const row = await this.settings.getRow();
    if (!row.queue_enabled) return { admitted: true, position: null, firstTime: false };

    return this.withLock(async (db) => {
      const now = new Date();
      await this.expireStale(db, now);

      const live = await db
        .selectFrom('order_queue_entries')
        .selectAll()
        .where('customer_id', '=', customerId)
        .where('status', 'in', ['waiting', 'admitted'])
        .executeTakeFirst();

      if (live?.status === 'admitted') return { admitted: true, position: null, firstTime: false };
      if (live) {
        return { admitted: false, position: await this.positionOf(db, live.created_at), firstTime: false };
      }

      const waiting = await this.countByStatus(db, 'waiting');
      const free = await this.free(db, row.queue_capacity);

      if (canAdmitDirectly(free, waiting)) {
        await db
          .insertInto('order_queue_entries')
          .values({
            customer_id: customerId,
            status: 'admitted',
            notified_at: now,
            admitted_until: new Date(now.getTime() + ADMISSION_TTL_MS),
          })
          .execute();
        return { admitted: true, position: null, firstTime: false };
      }

      await db.insertInto('order_queue_entries').values({ customer_id: customerId, status: 'waiting' }).execute();
      return { admitted: false, position: waiting + 1, firstTime: true };
    });
  }

  /**
   * Para `POST /orders` de WhatsApp/web: lanza `QueueWaitingError` si el cliente tiene que esperar. Si pasa, ya le
   * reservó (o confirmó) su cupo; `markUsed` lo cierra cuando el pedido se crea.
   */
  async assertCanOrder(customerId: string | undefined, channel: string): Promise<void> {
    if (!customerId || !QUEUED_CHANNELS.has(channel)) return;
    const row = await this.settings.getRow();
    if (!row.queue_enabled) return;

    // Reintento por timeout de un pedido que ya se creó hace instantes: no volver a pasar por la fila.
    const recent = await this.db
      .selectFrom('order_queue_entries')
      .select('id')
      .where('customer_id', '=', customerId)
      .where('status', '=', 'used')
      .where('used_at', '>', new Date(Date.now() - RECENTLY_USED_GRACE_MS))
      .executeTakeFirst();
    if (recent) return;

    const result = await this.requestAdmission(customerId);
    if (!result.admitted) throw new QueueWaitingError();
  }

  /** El cliente hizo su pedido: su cupo reservado pasa a ser un pedido real en cocina. */
  async markUsed(customerId: string | undefined): Promise<void> {
    if (!customerId) return;
    await this.db
      .updateTable('order_queue_entries')
      .set({ status: 'used', used_at: new Date() })
      .where('customer_id', '=', customerId)
      .where('status', '=', 'admitted')
      .execute();
  }

  /** El cliente en espera volvió a escribir: ¿hay que recordarle que espere? (con enfriamiento, no en cada mensaje) */
  async remind(customerId: string): Promise<{ shouldRemind: boolean; position: number | null }> {
    const entry = await this.db
      .selectFrom('order_queue_entries')
      .selectAll()
      .where('customer_id', '=', customerId)
      .where('status', '=', 'waiting')
      .executeTakeFirst();
    if (!entry) return { shouldRemind: false, position: null };

    const now = new Date();
    const position = await this.positionOf(this.db, entry.created_at);
    if (!shouldSendReminder(entry.last_reminder_at, now)) return { shouldRemind: false, position };

    await this.db.updateTable('order_queue_entries').set({ last_reminder_at: now }).where('id', '=', entry.id).execute();
    return { shouldRemind: true, position };
  }

  /** Cada ~30 s: libera cupos y avisa por WhatsApp a los que les toca. Devuelve a cuántos avisó. */
  async releaseNext(): Promise<number> {
    const row = await this.settings.getRow();
    if (!row.queue_enabled) return 0;

    const released = await this.withLock(async (db) => {
      const now = new Date();
      await this.expireStale(db, now);

      const waitingEntries = await db
        .selectFrom('order_queue_entries')
        .select(['id', 'customer_id'])
        .where('status', '=', 'waiting')
        .orderBy('created_at', 'asc')
        .limit(200)
        .execute();
      if (waitingEntries.length === 0) return [];

      const free = await this.free(db, row.queue_capacity);
      const take = releaseCount(free, row.queue_release_batch, waitingEntries.length);
      if (take === 0) return [];

      const chosen = waitingEntries.slice(0, take);
      await db
        .updateTable('order_queue_entries')
        .set({
          status: 'admitted',
          notified_at: now,
          admitted_until: new Date(now.getTime() + ADMISSION_TTL_MS),
        })
        .where(
          'id',
          'in',
          chosen.map((entry) => entry.id),
        )
        .execute();
      return chosen;
    });

    for (const entry of released) {
      try {
        await this.notifications.notifyNow({
          channel: 'whatsapp',
          kind: 'queue_ready',
          targetRef: entry.id,
          payload: { customerId: entry.customer_id, text: queueReadyText() },
        });
      } catch (error) {
        // El cupo ya quedó reservado; el aviso reintenta por notification_jobs (recovery cron).
        this.logger.warn(`queue_ready no se pudo encolar entry=${entry.id}: ${(error as Error).message}`);
      }
    }
    if (released.length > 0) this.logger.log(`Cola: se avisó a ${released.length} cliente(s) que ya pueden pedir.`);
    return released.length;
  }

  /** Reinicio diario: la fila no sobrevive a la noche. */
  async expireAll(): Promise<void> {
    await this.db
      .updateTable('order_queue_entries')
      .set({ status: 'expired' })
      .where('status', 'in', ['waiting', 'admitted'])
      .execute();
  }

  async summary(): Promise<QueueSummary> {
    const row = await this.settings.getRow();
    const [kitchenLoad, reserved, waiting] = await Promise.all([
      this.kitchenLoad(this.db),
      this.reserved(this.db),
      this.countByStatus(this.db, 'waiting'),
    ]);
    return { enabled: row.queue_enabled, kitchenLoad, capacity: row.queue_capacity, reserved, waiting };
  }

  // ---- internos ----------------------------------------------------------------------------------------------

  private async withLock<T>(fn: (db: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext('order_queue'))`.execute(trx);
      return fn(trx);
    });
  }

  /**
   * Pedidos que hoy ocupan la cocina. Mismo criterio que el tablero: un QR (o split) sin pagar no cuenta, porque
   * cocina ni siquiera lo ve todavía. "En camino" ya no cuenta — por eso el tracking libera cupos.
   */
  private async kitchenLoad(db: Kysely<Database>): Promise<number> {
    const result = await db
      .selectFrom('orders')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('status', 'in', ['confirmed', 'preparing', 'ready'])
      .where(sql<boolean>`not (payment_method in ('qr', 'split') and payment_status <> 'paid')`)
      .executeTakeFirstOrThrow();
    return result.n;
  }

  private async reserved(db: Kysely<Database>): Promise<number> {
    return this.countByStatus(db, 'admitted');
  }

  private async free(db: Kysely<Database>, capacity: number): Promise<number> {
    const [load, reserved] = await Promise.all([this.kitchenLoad(db), this.reserved(db)]);
    return freeSlots(capacity, load, reserved);
  }

  private async countByStatus(db: Kysely<Database>, status: 'waiting' | 'admitted'): Promise<number> {
    const result = await db
      .selectFrom('order_queue_entries')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('status', '=', status)
      .executeTakeFirstOrThrow();
    return result.n;
  }

  private async positionOf(db: Kysely<Database>, createdAt: Date): Promise<number> {
    const result = await db
      .selectFrom('order_queue_entries')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('status', '=', 'waiting')
      .where('created_at', '<=', createdAt)
      .executeTakeFirstOrThrow();
    return Math.max(1, result.n);
  }

  /** Cupos prometidos que nadie usó a tiempo, y esperas olvidadas: se liberan. */
  private async expireStale(db: Kysely<Database>, now: Date): Promise<void> {
    await db
      .updateTable('order_queue_entries')
      .set({ status: 'expired' })
      .where((eb) =>
        eb.or([
          eb.and([eb('status', '=', 'admitted'), eb('admitted_until', '<', now)]),
          eb.and([eb('status', '=', 'waiting'), eb('created_at', '<', new Date(now.getTime() - WAITING_TTL_MS))]),
        ]),
      )
      .execute();
  }
}

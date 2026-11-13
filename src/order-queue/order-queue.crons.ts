import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { dailyResetDue } from '../operational-settings/daily-reset';
import { OperationalSettingsService } from '../operational-settings/operational-settings.service';
import { OrderQueueService } from './order-queue.service';

/** Cada 30 s: si la cola está activa y hay cupos libres, avisa a los que les toca. */
@Injectable()
export class OrderQueueReleaseCron {
  private readonly logger = new Logger(OrderQueueReleaseCron.name);
  private isRunning = false;

  constructor(private readonly queue: OrderQueueService) {}

  @Cron('*/30 * * * * *')
  async run(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this.queue.releaseNext();
    } catch (error) {
      this.logger.error(`releaseNext falló: ${(error as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }
}

/**
 * Una vez al día, a `daily_reset_hour` (7:00 por defecto), los modos de ocasión especial vuelven a su valor normal:
 * "Seguimos atendiendo", "Cerrado" y cola, los tres apagados. Así un olvido de anoche no afecta a la noche siguiente.
 * NO toca lo fijo: efectivo, horario, mensajes, regla de promociones ni capacidad de la cola.
 */
@Injectable()
export class OperationalModesResetCron {
  private readonly logger = new Logger(OperationalModesResetCron.name);
  private isRunning = false;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly settings: OperationalSettingsService,
    private readonly queue: OrderQueueService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const row = await this.settings.getRow();
      const { due, today } = dailyResetDue(new Date(), row.daily_reset_hour, row.last_daily_reset_on);
      if (!due) return;

      // El `where` sobre last_daily_reset_on hace el reinicio idempotente aunque haya más de una instancia corriendo.
      const updated = await this.db
        .updateTable('operational_settings')
        .set({
          extended_service_enabled: false,
          manually_closed: false,
          queue_enabled: false,
          last_daily_reset_on: today,
          updated_at: new Date(),
        })
        .where('id', '=', true)
        .where((eb) => eb.or([eb('last_daily_reset_on', 'is', null), eb('last_daily_reset_on', '<>', today)]))
        .executeTakeFirst();

      if (Number(updated.numUpdatedRows) > 0) {
        await this.queue.expireAll();
        this.logger.log(`Reinicio diario de modos operativos (${today}, ${row.daily_reset_hour}:00).`);
      }
    } catch (error) {
      this.logger.error(`Reinicio diario falló: ${(error as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }
}

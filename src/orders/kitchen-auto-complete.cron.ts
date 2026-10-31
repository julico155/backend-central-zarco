import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OperationalSettingsService } from '../operational-settings/operational-settings.service';
import { lastClosesHourCrossing } from '../common/time/service-window';
import { OrdersService } from './orders.service';

/**
 * Fin de jornada: todo lo que quedó pendiente en cocina/reparto de antes
 * del último cruce de `closesHour` pasa a `delivered`. Corre cada minuto,
 * pero es idempotente por diseño — el corte (`lastClosesHourCrossing`)
 * excluye pedidos creados después del cruce, así que un pedido nuevo
 * dentro de la misma hora de cierre nunca se toca, y un pedido ya resuelto
 * sale del WHERE de `autoCompletePendingKitchenOrders` apenas se actualiza.
 */
@Injectable()
export class KitchenAutoCompleteCron {
  private readonly logger = new Logger(KitchenAutoCompleteCron.name);
  private isRunning = false;

  constructor(
    private readonly orders: OrdersService,
    private readonly operationalSettings: OperationalSettingsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const settings = await this.operationalSettings.getRow();
      const cutoff = lastClosesHourCrossing(new Date(), settings.business_closes_hour);
      const completed = await this.orders.autoCompletePendingKitchenOrders(cutoff);
      if (completed > 0) {
        this.logger.log(`Cierre de jornada: ${completed} pedidos pendientes pasados a delivered.`);
      }
    } catch (error) {
      this.logger.error(`autoCompletePendingKitchenOrders falló: ${(error as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }
}

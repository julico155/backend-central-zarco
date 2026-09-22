import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LogisticsDispatchWorkerService } from './logistics-dispatch-worker.service';

@Injectable()
export class LogisticsDispatchCron {
  private readonly logger = new Logger(LogisticsDispatchCron.name);

  constructor(private readonly worker: LogisticsDispatchWorkerService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    const { claimed, recovered } = await this.worker.dispatchPending();
    if (claimed > 0 || recovered > 0) {
      this.logger.log(`Logistics dispatch: ${claimed} claimed, ${recovered} leases recovered.`);
    }
  }
}

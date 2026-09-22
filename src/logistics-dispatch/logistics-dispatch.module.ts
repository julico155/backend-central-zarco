import { Module } from '@nestjs/common';
import { LogisticsDispatchConfigValidator } from './logistics-dispatch-config.validator';
import { LogisticsDispatchCron } from './logistics-dispatch.cron';
import { LogisticsDispatchJobsService } from './logistics-dispatch-jobs.service';
import { LogisticsDispatchWorkerService } from './logistics-dispatch-worker.service';
import { LogisticsHttpClientService } from './logistics-http-client.service';

@Module({
  providers: [
    LogisticsDispatchJobsService,
    LogisticsDispatchConfigValidator,
    LogisticsHttpClientService,
    LogisticsDispatchWorkerService,
    LogisticsDispatchCron,
  ],
  exports: [LogisticsDispatchJobsService],
})
export class LogisticsDispatchModule {}

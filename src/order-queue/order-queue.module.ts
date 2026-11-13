import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommonModule } from '../common/common.module';
import { CustomersModule } from '../customers/customers.module';
import { NotificationsOutModule } from '../notifications-out/notifications-out.module';
import { OperationalSettingsModule } from '../operational-settings/operational-settings.module';
import { OperationalModesResetCron, OrderQueueReleaseCron } from './order-queue.crons';
import { OrderQueueController } from './order-queue.controller';
import { OrderQueueService } from './order-queue.service';

@Module({
  imports: [CommonModule, AuthModule, CustomersModule, NotificationsOutModule, OperationalSettingsModule],
  controllers: [OrderQueueController],
  providers: [OrderQueueService, OrderQueueReleaseCron, OperationalModesResetCron],
  exports: [OrderQueueService],
})
export class OrderQueueModule {}

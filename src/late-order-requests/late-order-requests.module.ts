import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { NotificationsOutModule } from '../notifications-out/notifications-out.module';
import { LateOrderRequestsController } from './late-order-requests.controller';
import { LateOrderRequestsService } from './late-order-requests.service';

@Module({
  imports: [CommonModule, NotificationsOutModule],
  controllers: [LateOrderRequestsController],
  providers: [LateOrderRequestsService],
  exports: [LateOrderRequestsService],
})
export class LateOrderRequestsModule {}

import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { NotificationsOutModule } from '../notifications-out/notifications-out.module';
import { OrdersModule } from '../orders/orders.module';
import { LateOrderRequestsController } from './late-order-requests.controller';
import { LateOrderRequestsService } from './late-order-requests.service';

@Module({
  imports: [CommonModule, NotificationsOutModule, OrdersModule],
  controllers: [LateOrderRequestsController],
  providers: [LateOrderRequestsService],
  exports: [LateOrderRequestsService],
})
export class LateOrderRequestsModule {}

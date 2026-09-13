import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { NotificationsOutModule } from '../notifications-out/notifications-out.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [CommonModule, NotificationsOutModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}

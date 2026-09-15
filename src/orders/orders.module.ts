import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsOutModule } from '../notifications-out/notifications-out.module';
import { OperationalSettingsModule } from '../operational-settings/operational-settings.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [
    CommonModule,
    AuthModule,
    NotificationsOutModule,
    OperationalSettingsModule,
    DeliveryModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}

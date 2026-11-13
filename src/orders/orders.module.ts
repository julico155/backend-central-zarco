import { forwardRef, Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsOutModule } from '../notifications-out/notifications-out.module';
import { OrderQueueModule } from '../order-queue/order-queue.module';
import { OperationalSettingsModule } from '../operational-settings/operational-settings.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { CashRegisterModule } from '../cash-register/cash-register.module';
import { BankQrModule } from '../bank-qr/bank-qr.module';
import { DeliveryNoticesModule } from '../delivery-notices/delivery-notices.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { UnpaidOrdersExpiryCron } from './unpaid-orders-expiry.cron';
import { KitchenAutoCompleteCron } from './kitchen-auto-complete.cron';

@Module({
  imports: [
    CommonModule,
    AuthModule,
    NotificationsOutModule,
    OperationalSettingsModule,
    OrderQueueModule,
    forwardRef(() => DeliveryModule),
    CashRegisterModule,
    BankQrModule,
    DeliveryNoticesModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService, UnpaidOrdersExpiryCron, KitchenAutoCompleteCron],
  exports: [OrdersService],
})
export class OrdersModule {}

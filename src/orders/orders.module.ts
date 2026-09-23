import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsOutModule } from '../notifications-out/notifications-out.module';
import { OperationalSettingsModule } from '../operational-settings/operational-settings.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { CashRegisterModule } from '../cash-register/cash-register.module';
import { BankQrModule } from '../bank-qr/bank-qr.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { UnpaidOrdersExpiryCron } from './unpaid-orders-expiry.cron';

@Module({
  imports: [
    CommonModule,
    AuthModule,
    NotificationsOutModule,
    OperationalSettingsModule,
    DeliveryModule,
    CashRegisterModule,
    BankQrModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService, UnpaidOrdersExpiryCron],
  exports: [OrdersService],
})
export class OrdersModule {}

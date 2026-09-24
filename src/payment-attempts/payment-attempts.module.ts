import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsOutModule } from '../notifications-out/notifications-out.module';
import { CashRegisterModule } from '../cash-register/cash-register.module';
import { DeliveryNoticeModule } from '../delivery-notice/delivery-notice.module';
import { PaymentAttemptsController } from './payment-attempts.controller';
import { PaymentAttemptsService } from './payment-attempts.service';

@Module({
  imports: [
    CommonModule,
    AuthModule,
    NotificationsOutModule,
    CashRegisterModule,
    DeliveryNoticeModule,
  ],
  controllers: [PaymentAttemptsController],
  providers: [PaymentAttemptsService],
  exports: [PaymentAttemptsService],
})
export class PaymentAttemptsModule {}

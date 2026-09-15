import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { NotificationsOutModule } from '../notifications-out/notifications-out.module';
import { PaymentAttemptsController } from './payment-attempts.controller';
import { PaymentAttemptsService } from './payment-attempts.service';

@Module({
  imports: [CommonModule, NotificationsOutModule],
  controllers: [PaymentAttemptsController],
  providers: [PaymentAttemptsService],
  exports: [PaymentAttemptsService],
})
export class PaymentAttemptsModule {}

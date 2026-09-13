import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { PaymentAttemptsController } from './payment-attempts.controller';
import { PaymentAttemptsService } from './payment-attempts.service';

@Module({
  imports: [CommonModule],
  controllers: [PaymentAttemptsController],
  providers: [PaymentAttemptsService],
  exports: [PaymentAttemptsService],
})
export class PaymentAttemptsModule {}

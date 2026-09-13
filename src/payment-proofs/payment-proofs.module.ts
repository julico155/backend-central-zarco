import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { PaymentProofsController } from './payment-proofs.controller';
import { PaymentProofsService } from './payment-proofs.service';

@Module({
  imports: [CommonModule],
  controllers: [PaymentProofsController],
  providers: [PaymentProofsService],
  exports: [PaymentProofsService],
})
export class PaymentProofsModule {}

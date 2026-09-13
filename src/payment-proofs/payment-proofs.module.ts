import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { PaymentProofsController } from './payment-proofs.controller';
import { PaymentProofsService } from './payment-proofs.service';
import { LocalDiskPaymentProofStorage } from './storage/local-disk-payment-proof-storage';
import { PAYMENT_PROOF_STORAGE } from './storage/payment-proof-storage';

@Module({
  imports: [CommonModule],
  controllers: [PaymentProofsController],
  providers: [
    PaymentProofsService,
    { provide: PAYMENT_PROOF_STORAGE, useClass: LocalDiskPaymentProofStorage },
  ],
  exports: [PaymentProofsService],
})
export class PaymentProofsModule {}

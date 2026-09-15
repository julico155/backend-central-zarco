import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { CommonModule } from '../common/common.module';
import { PaymentProofsController } from './payment-proofs.controller';
import { PaymentProofsService } from './payment-proofs.service';
import { LocalDiskPaymentProofStorage } from './storage/local-disk-payment-proof-storage';
import { S3PaymentProofStorage } from './storage/s3-payment-proof-storage';
import { PAYMENT_PROOF_STORAGE, PaymentProofStorage } from './storage/payment-proof-storage';

@Module({
  imports: [CommonModule],
  controllers: [PaymentProofsController],
  providers: [
    PaymentProofsService,
    {
      provide: PAYMENT_PROOF_STORAGE,
      useFactory: (config: ConfigService<AppConfig, true>): PaymentProofStorage => {
        const s3 = config.get('s3', { infer: true });
        if (s3.bucket && s3.accessKeyId && s3.secretAccessKey) {
          return new S3PaymentProofStorage({
            bucket: s3.bucket,
            region: s3.region,
            accessKeyId: s3.accessKeyId,
            secretAccessKey: s3.secretAccessKey,
            endpoint: s3.endpoint || undefined,
          });
        }
        return new LocalDiskPaymentProofStorage();
      },
      inject: [ConfigService],
    },
  ],
  exports: [PaymentProofsService],
})
export class PaymentProofsModule {}

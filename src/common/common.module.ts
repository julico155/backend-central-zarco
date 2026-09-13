import { Module } from '@nestjs/common';
import { ServiceAuthGuard } from './guards/service-auth.guard';
import { IdempotencyService } from './idempotency/idempotency.service';

@Module({
  providers: [ServiceAuthGuard, IdempotencyService],
  exports: [ServiceAuthGuard, IdempotencyService],
})
export class CommonModule {}

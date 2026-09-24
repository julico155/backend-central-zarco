import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { KapsoModule } from '../kapso/kapso.module';
import { PaymentProofsModule } from '../payment-proofs/payment-proofs.module';
import { PaymentProofAnalysisService } from './payment-proof-analysis.service';
import { PaymentProofCaptureService } from './payment-proof-capture.service';

/**
 * SarcoPaymentProofModule — Fase 2D: captura y análisis visual de
 * comprobantes. Reutiliza `PaymentProofsService` (asociación/routing/
 * idempotencia YA existentes en Central, sin duplicar) y
 * `KapsoMediaResolverService` (descarga privada ya migrada, Fase 2B). NO
 * incluye `PaymentAttemptsService.decide` — la aceptación/rechazo final
 * sigue siendo una decisión humana, fuera de esta fase.
 */
@Module({
  imports: [CustomersModule, KapsoModule, PaymentProofsModule],
  providers: [PaymentProofAnalysisService, PaymentProofCaptureService],
  exports: [PaymentProofCaptureService],
})
export class SarcoPaymentProofModule {}

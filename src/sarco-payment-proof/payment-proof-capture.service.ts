import { Injectable, Logger } from '@nestjs/common';
import { CustomersService } from '../customers/customers.service';
import { KapsoMediaResolverService } from '../kapso/kapso-media-resolver.service';
import type { NormalizedKapsoEvent } from '../kapso/kapso.types';
import { DomainException } from '../common/exceptions/domain-exception';
import { PaymentProofsService } from '../payment-proofs/payment-proofs.service';
import { PaymentProofAnalysisService } from './payment-proof-analysis.service';

const logger = new Logger('PaymentProofCaptureService');

export type CaptureOutcome =
  /** No es una imagen, o no trae wamid: nunca se intentó nada. */
  | 'skipped'
  /**
   * `PaymentProofsService.intake` resolvió `no_match` — NINGÚN pedido QR
   * abierto de este cliente. Es EXACTAMENTE la puerta `isProofBearing` de
   * sarcoRestaurant (`!(method==='unresolved' && routingException===null)`):
   * Central ya distingue ese caso como `no_match`, así que no hace falta
   * reimplementar la regla — el llamador debe tratar la imagen como
   * cualquier otra, elegible para el agente conversacional.
   */
  | 'not_a_proof'
  /** Se capturó como comprobante (con o sin pedido asociado) y, si había pedido, se analizó. */
  | 'captured';

/**
 * Puente entre el webhook de Kapso y `PaymentProofsService`. Puerto directo
 * de sarcoRestaurant (`intake-service.ts` + `agent-gate.ts`), adaptado a los
 * servicios YA existentes en Central: la asociación/routing/idempotencia
 * NO se reimplementan aquí, `PaymentProofsService.intake` ya las tiene.
 *
 * Solo se descarga la media (privada, vía `KapsoMediaResolverService` ya
 * migrado) y se decide, por el resultado de `intake`, si esta imagen sigue
 * su camino como comprobante o si el llamador debe tratarla como una imagen
 * normal.
 */
@Injectable()
export class PaymentProofCaptureService {
  constructor(
    private readonly customers: CustomersService,
    private readonly media: KapsoMediaResolverService,
    private readonly proofs: PaymentProofsService,
    private readonly analysis: PaymentProofAnalysisService,
  ) {}

  async tryCapture(event: NormalizedKapsoEvent): Promise<CaptureOutcome> {
    if (event.contentType !== 'image' || !event.image || !event.messageId) {
      return 'skipped';
    }

    const customer = await this.customers.findOrCreate({ phone: event.customerPhone });

    const resolved = await this.media.resolve(event.image);
    if (!resolved.ok) {
      // No se pudo bajar la imagen: no hay bytes que capturar. Se deja
      // pasar como imagen normal en vez de fallar en silencio — es mejor que
      // el agente conversacional avise de que no pudo procesarla (ver
      // `MEDIA_FAILURE_NOTICE`, Fase 2B) a que el mensaje desaparezca.
      logger.warn(`payment_proof_media_unresolved reason=${resolved.reason}`);
      return 'not_a_proof';
    }

    let proof;
    try {
      proof = await this.proofs.intake({
        customerId: customer.id,
        sourceMessageId: event.messageId,
        mimeType: resolved.mimeType,
        fileBase64: resolved.bytes.toString('base64'),
      });
    } catch (error) {
      if (error instanceof DomainException && error.code === 'payment_proof_no_match') {
        return 'not_a_proof';
      }
      throw error;
    }

    logger.log(
      `payment_proof_captured proofId=${proof.id} matchMethod=${proof.matchMethod} captureStatus=${proof.captureStatus}`,
    );

    if (proof.captureStatus === 'stored') {
      try {
        await this.analysis.analyze({
          proofId: proof.id,
          orderId: proof.orderId,
          bytes: resolved.bytes,
          mimeType: resolved.mimeType,
          receivedAtMs: Date.now(),
        });
      } catch (error) {
        // El análisis es un insumo, no una condición de captura: un fallo
        // aquí no puede deshacer que el comprobante ya quedó guardado y
        // asociado. Queda `analysis_status='pending'` para revisión manual.
        logger.warn(
          `payment_proof_analysis_threw proofId=${proof.id} error=${(error as Error).message}`,
        );
      }
    }

    return 'captured';
  }
}

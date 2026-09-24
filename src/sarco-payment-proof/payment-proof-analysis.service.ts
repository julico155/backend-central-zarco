import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { AppConfig } from '../config/configuration';
import { PaymentProofsService } from '../payment-proofs/payment-proofs.service';
import { createOpenAiModel } from '../sarco-agent/openai/adapter';
import { parseExpectedAccount } from './expected-account';
import { judgeProof, type ExpectedAmounts } from './proof-analysis';
import { readProofFacts } from './proof-vision';

const logger = new Logger('PaymentProofAnalysisService');

const PROOF_ANALYSIS_DEFAULT_MODEL = 'gpt-5-mini';

/**
 * Orquesta el análisis visual de UN comprobante ya capturado (`capture_status='stored'`).
 * Puerto directo de sarcoRestaurant (analysis-service.ts): lee hechos con
 * OpenAI Vision, calcula `referenceReused` contra la base, compara contra
 * los montos REALES del pedido en Central y persiste el veredicto vía
 * `PaymentProofsService.recordAnalysis` — nunca escribe la tabla a mano.
 *
 * Nunca lanza: un fallo de OpenAI (timeout, clave inválida, respuesta
 * inválida) cierra en `analysis_status='failed'`, nunca corrompe
 * `capture_status` ni el estado de pago del pedido — eso sigue intacto,
 * esperando revisión humana igual que antes de esta fase.
 */
@Injectable()
export class PaymentProofAnalysisService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly proofs: PaymentProofsService,
  ) {}

  /**
   * `proofId` debe estar `capture_status='stored'` y `analysis_status='pending'`
   * — quien llama (`PaymentProofCaptureService`) ya lo garantiza. Idempotente
   * por diseño: si ya se analizó (`analysis_status !== 'pending'`), no se
   * vuelve a llamar a OpenAI — ver la comprobación en el llamador.
   */
  async analyze(input: {
    proofId: string;
    orderId: string | null;
    bytes: Buffer;
    mimeType: string;
    receivedAtMs: number;
  }): Promise<void> {
    const paymentProof = this.config.get('paymentProof', { infer: true });
    if (paymentProof.analysisEnabled !== 'true') {
      // Interruptor de apagado explícito: la fila queda 'pending', igual que
      // en sarcoRestaurant cuando el análisis está apagado o falta la clave.
      return;
    }

    const agent = this.config.get('agent', { infer: true });
    if (!agent.apiKey) {
      logger.warn(`payment_proof_analysis_not_configured proofId=${input.proofId}`);
      return;
    }

    const model = createOpenAiModel({
      apiKey: agent.apiKey,
      model: paymentProof.analysisModel || PROOF_ANALYSIS_DEFAULT_MODEL,
    });

    const dataUrl = `data:${input.mimeType};base64,${input.bytes.toString('base64')}`;
    const read = await readProofFacts(model, dataUrl);

    if (!read.ok) {
      logger.warn(
        `payment_proof_analysis_failed proofId=${input.proofId} error=${read.error} code=${read.code ?? ''}`,
      );
      await this.proofs.markAnalysisFailed(input.proofId);
      return;
    }

    const expected = parseExpectedAccount({
      bank: paymentProof.expectedBank,
      bankAliases: paymentProof.expectedBankAliases,
      accountNumbers: paymentProof.expectedAccountNumbers,
      holder: paymentProof.expectedHolder,
      holderAliases: paymentProof.expectedHolderAliases,
    });

    const referenceReused =
      read.facts.transactionRef !== null
        ? await this.proofs.findByTransactionRef(read.facts.transactionRef, input.proofId)
        : false;

    const amounts = input.orderId !== null ? await this.loadExpectedAmounts(input.orderId) : null;

    const judgement = judgeProof(read.facts, {
      // Sin cuenta configurada, todo queda `unknown` — nunca acusa (ver
      // `expected-account.ts`). Es el mismo fail-closed que la captura.
      expected: expected ?? { bankNames: [], accountNumbers: [], holderNames: [] },
      receivedAtMs: input.receivedAtMs,
      referenceReused,
      amounts,
    });

    await this.proofs.recordAnalysis(input.proofId, {
      verdict: judgement.verdict,
      reasons: judgement.reasons,
      amountLabel: judgement.amountLabel,
      facts: read.facts,
      model: read.model,
    });

    logger.log(
      `payment_proof_analyzed proofId=${input.proofId} verdict=${judgement.verdict} amountLabel=${judgement.amountLabel ?? 'null'}`,
    );
  }

  private async loadExpectedAmounts(orderId: string): Promise<ExpectedAmounts | null> {
    const row = await this.db
      .selectFrom('orders')
      .select(['subtotal_amount', 'total_amount'])
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!row) return null;
    return { subtotal: Number(row.subtotal_amount), total: Number(row.total_amount) };
  }
}

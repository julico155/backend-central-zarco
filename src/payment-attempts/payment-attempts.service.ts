import { Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database, OrderPaymentStatus, PaymentAttemptReviewStatus } from '../database/types';
import { NotFoundDomainError } from '../common/exceptions/domain-exception';
import { NotificationsOutService } from '../notifications-out/notifications-out.service';

export interface PaymentAttemptResponse {
  id: string;
  orderId: string;
  customerId: string | null;
  openedAt: string;
  openedAs: string;
  reviewStatus: PaymentAttemptReviewStatus;
  reviewedAt: string | null;
}

export interface DecidePaymentAttemptResult {
  attempt: PaymentAttemptResponse;
  /** true solo si ESTA llamada movió pending_review -> decision (invariante 5). */
  won: boolean;
}

@Injectable()
export class PaymentAttemptsService {
  private readonly logger = new Logger(PaymentAttemptsService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly notifications: NotificationsOutService,
  ) {}

  async findByOrder(orderId: string): Promise<PaymentAttemptResponse[]> {
    const rows = await this.db
      .selectFrom('payment_attempts')
      .selectAll()
      .where('order_id', '=', orderId)
      .orderBy('opened_at', 'desc')
      .execute();
    return rows.map(toResponse);
  }

  /**
   * CAS puro pending_review -> accepted|rejected (invariante 5 y 6 del
   * plan). El UPDATE con WHERE review_status = 'pending_review' es el CAS:
   * bajo carga concurrente, Postgres serializa las dos escrituras y solo una
   * de ellas afecta una fila (won: true) — la otra no encuentra la fila en
   * 'pending_review' y vuelve con won: false, sin volver a evaluar nada.
   *
   * Cuando won es true, en la MISMA transacción se propaga a
   * orders.payment_status ('paid' | 'rejected') — nunca si won es false,
   * para no duplicar el efecto cuando dos decisiones llegan casi al mismo
   * tiempo. El aviso al cliente es best-effort, fuera de la transacción.
   */
  async decide(
    attemptId: string,
    decision: 'accepted' | 'rejected',
  ): Promise<DecidePaymentAttemptResult> {
    const result = await this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('payment_attempts')
        .set({ review_status: decision, reviewed_at: new Date(), updated_at: new Date() })
        .where('id', '=', attemptId)
        .where('review_status', '=', 'pending_review')
        .returningAll()
        .executeTakeFirst();

      if (!updated) {
        const current = await trx
          .selectFrom('payment_attempts')
          .selectAll()
          .where('id', '=', attemptId)
          .executeTakeFirst();
        if (!current) throw new NotFoundDomainError('payment_attempt', attemptId);
        return { attempt: toResponse(current), won: false as const, customerId: null };
      }

      const paymentStatus: OrderPaymentStatus = decision === 'accepted' ? 'paid' : 'rejected';
      const order = await trx
        .updateTable('orders')
        .set({ payment_status: paymentStatus, updated_at: new Date() })
        .where('id', '=', updated.order_id)
        .returning(['customer_id'])
        .executeTakeFirstOrThrow();

      return {
        attempt: toResponse(updated),
        won: true as const,
        customerId: updated.customer_id ?? order.customer_id,
      };
    });

    if (result.won) {
      this.notifyCustomerBestEffort(attemptId, result.customerId, decision);
    }
    return { attempt: result.attempt, won: result.won };
  }

  private notifyCustomerBestEffort(
    attemptId: string,
    customerId: string | null,
    decision: 'accepted' | 'rejected',
  ): void {
    if (!customerId) return;
    const text =
      decision === 'accepted'
        ? 'Tu pago fue confirmado, tu pedido sigue en preparación.'
        : 'No pudimos validar tu comprobante de pago. Por favor contáctanos para resolverlo.';
    this.notifications
      .notifyNow({
        channel: 'whatsapp',
        kind: 'payment_decision',
        targetRef: attemptId,
        payload: { customerId, text },
      })
      .catch((error: Error) =>
        this.logger.warn(`No se pudo notificar decisión de pago ${attemptId}: ${error.message}`),
      );
  }
}

function toResponse(row: {
  id: string;
  order_id: string;
  customer_id: string | null;
  opened_at: Date | string;
  opened_as: string;
  review_status: PaymentAttemptReviewStatus;
  reviewed_at: Date | string | null;
}): PaymentAttemptResponse {
  return {
    id: row.id,
    orderId: row.order_id,
    customerId: row.customer_id,
    openedAt: new Date(row.opened_at).toISOString(),
    openedAs: row.opened_as,
    reviewStatus: row.review_status,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
  };
}

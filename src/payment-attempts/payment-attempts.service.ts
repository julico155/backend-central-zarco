import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database, PaymentAttemptReviewStatus } from '../database/types';
import { NotFoundDomainError } from '../common/exceptions/domain-exception';

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
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

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
   * TODO fase de implementación (pagos, fase 5 del plan): cuando won es
   * true, en la MISMA transacción (o inmediatamente después, best-effort)
   * hay que:
   *   - actualizar orders.payment_status ('paid' | 'rejected' según decision)
   *   - llamar a NotificationsOutService para avisar cliente/mostrador
   * Si won es false, NUNCA disparar ese efecto — evita duplicar el aviso
   * cuando dos decisiones llegan casi al mismo tiempo.
   */
  async decide(
    attemptId: string,
    decision: 'accepted' | 'rejected',
  ): Promise<DecidePaymentAttemptResult> {
    const updated = await this.db
      .updateTable('payment_attempts')
      .set({ review_status: decision, reviewed_at: new Date(), updated_at: new Date() })
      .where('id', '=', attemptId)
      .where('review_status', '=', 'pending_review')
      .returningAll()
      .executeTakeFirst();

    if (updated) {
      return { attempt: toResponse(updated), won: true };
    }

    const current = await this.db
      .selectFrom('payment_attempts')
      .selectAll()
      .where('id', '=', attemptId)
      .executeTakeFirst();
    if (!current) throw new NotFoundDomainError('payment_attempt', attemptId);
    return { attempt: toResponse(current), won: false };
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

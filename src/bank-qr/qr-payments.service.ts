import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { BankQrChargeStatus, Database } from '../database/types';
import { DomainException, NotFoundDomainError, ValidationError } from '../common/exceptions/domain-exception';
import { dateInBolivia } from '../common/time/service-window';
import { BanecoClientService } from '../baneco/baneco-client.service';
import { PaymentAttemptsService } from '../payment-attempts/payment-attempts.service';

export interface QrChargeResponse {
  orderId: string;
  status: BankQrChargeStatus;
  qrImageUrl: string;
  dueDate: string;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

/**
 * Genera y da seguimiento al QR real de Banco Económico para un pedido.
 * Nunca decide el pago por su cuenta — cuando confirma que el banco lo pagó
 * (ver `resolveCharge`), llama a `PaymentAttemptsService.decide()`, el mismo
 * camino que ya usa la revisión manual: reusa el CAS, el vínculo a caja y la
 * notificación al cliente sin duplicar nada de esa lógica acá.
 */
@Injectable()
export class QrPaymentsService {
  private readonly logger = new Logger(QrPaymentsService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly baneco: BanecoClientService,
    private readonly paymentAttempts: PaymentAttemptsService,
  ) {}

  /**
   * Idempotente: si ya hay un payment_attempt vivo para el pedido (mismo
   * índice único que usa todo el resto del sistema), devuelve el QR ya
   * generado en vez de crear uno nuevo.
   */
  async generateForOrder(orderId: string): Promise<QrChargeResponse> {
    const order = await this.db
      .selectFrom('orders')
      .select(['id', 'order_number', 'payment_method', 'payment_status', 'total_amount', 'customer_id'])
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order) throw new NotFoundDomainError('order', orderId);
    if (order.payment_method !== 'qr') {
      throw new ValidationError('El pedido no es de pago QR.');
    }
    if (order.payment_status === 'paid') {
      throw new DomainException(
        'order_already_paid',
        HttpStatus.CONFLICT,
        'El pedido ya está pagado.',
      );
    }

    const existingAttempt = await this.db
      .selectFrom('payment_attempts')
      .select('id')
      .where('order_id', '=', orderId)
      .where('review_status', 'in', ['pending_review', 'accepted'])
      .executeTakeFirst();
    if (existingAttempt) {
      const existingCharge = await this.db
        .selectFrom('bank_qr_charges')
        .selectAll()
        .where('payment_attempt_id', '=', existingAttempt.id)
        .executeTakeFirst();
      if (existingCharge) return toResponse(existingCharge, orderId);
    }

    const dueDate = dateInBolivia(new Date());
    let generated;
    try {
      generated = await this.baneco.generateQR({
        transactionId: order.order_number,
        amount: Number(order.total_amount),
        description: `Pedido ${order.order_number}`,
        dueDate,
      });
    } catch (error) {
      this.logger.error(`generateQR falló para ${orderId}: ${(error as Error).message}`);
      throw new DomainException(
        'qr_generation_failed',
        HttpStatus.BAD_GATEWAY,
        'No se pudo generar el QR con el banco. Reintentá en un momento.',
      );
    }

    const charge = await this.db.transaction().execute(async (trx) => {
      let attempt;
      try {
        attempt = await trx
          .insertInto('payment_attempts')
          .values({ order_id: orderId, customer_id: order.customer_id, opened_as: 'normal' })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DomainException(
            'payment_attempt_already_live',
            HttpStatus.CONFLICT,
            'Ya hay un intento de pago pendiente o aceptado para este pedido.',
          );
        }
        throw error;
      }

      return trx
        .insertInto('bank_qr_charges')
        .values({
          order_id: orderId,
          payment_attempt_id: attempt.id,
          qr_id: generated.qrId,
          transaction_id: order.order_number,
          amount: order.total_amount,
          due_date: dueDate,
          qr_image_base64: generated.qrImageBase64,
          raw_generate_response: JSON.stringify(generated.raw),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    return toResponse(charge, orderId);
  }

  async getQrImage(orderId: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const charge = await this.db
      .selectFrom('bank_qr_charges')
      .select('qr_image_base64')
      .where('order_id', '=', orderId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    if (!charge) throw new NotFoundDomainError('bank_qr_charge', orderId);
    return { bytes: Buffer.from(charge.qr_image_base64, 'base64'), mimeType: 'image/png' };
  }

  /** Re-verifica un qrId puntual contra el banco y resuelve si corresponde. Usado por el cron y por el webhook. */
  async resolveCharge(qrId: string): Promise<void> {
    const charge = await this.db
      .selectFrom('bank_qr_charges')
      .selectAll()
      .where('qr_id', '=', qrId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (!charge) return;

    let statusResult;
    try {
      statusResult = await this.baneco.statusQR(qrId);
    } catch (error) {
      this.logger.warn(`statusQR falló para ${qrId}: ${(error as Error).message}`);
      return;
    }

    if (statusResult.statusQrCode === 1) {
      await this.db
        .updateTable('bank_qr_charges')
        .set({
          status: 'confirmed',
          raw_status_response: JSON.stringify(statusResult.raw),
          updated_at: new Date(),
        })
        .where('id', '=', charge.id)
        .execute();
      await this.paymentAttempts.decide(charge.payment_attempt_id, 'accepted');
      return;
    }

    if (statusResult.statusQrCode === 9) {
      await this.db
        .updateTable('bank_qr_charges')
        .set({
          status: 'cancelled',
          raw_status_response: JSON.stringify(statusResult.raw),
          updated_at: new Date(),
        })
        .where('id', '=', charge.id)
        .execute();
      return;
    }

    // statusQrCode === 0 (sigue pendiente): si ya venció, se anula del lado
    // del banco y se marca expired — el payment_attempt sigue pending_review
    // para que el staff pueda regenerar o confirmar a mano.
    const today = dateInBolivia(new Date());
    if (charge.due_date < today) {
      try {
        await this.baneco.cancelQR(qrId);
      } catch (error) {
        this.logger.warn(`cancelQR falló para ${qrId} vencido: ${(error as Error).message}`);
      }
      await this.db
        .updateTable('bank_qr_charges')
        .set({ status: 'expired', updated_at: new Date() })
        .where('id', '=', charge.id)
        .execute();
    }
  }

  async recordNotifyPayload(qrId: string | null, payload: unknown): Promise<void> {
    if (!qrId) return;
    await this.db
      .updateTable('bank_qr_charges')
      .set({ raw_notify_payload: JSON.stringify(payload), updated_at: new Date() })
      .where('qr_id', '=', qrId)
      .execute();
  }

  async findPendingQrIds(limit: number): Promise<string[]> {
    const rows = await this.db
      .selectFrom('bank_qr_charges')
      .select('qr_id')
      .where('status', '=', 'pending')
      .orderBy('created_at', 'asc')
      .limit(limit)
      .execute();
    return rows.map((r) => r.qr_id);
  }

  /** Best-effort: cancelar el QR bancario cuando el pedido se cancela por afuera. No bloquea la cancelación del pedido. */
  async cancelForOrder(orderId: string): Promise<void> {
    const charge = await this.db
      .selectFrom('bank_qr_charges')
      .select(['id', 'qr_id'])
      .where('order_id', '=', orderId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (!charge) return;

    try {
      await this.baneco.cancelQR(charge.qr_id);
    } catch (error) {
      this.logger.warn(`cancelQR falló al cancelar pedido ${orderId}: ${(error as Error).message}`);
    }
    await this.db
      .updateTable('bank_qr_charges')
      .set({ status: 'cancelled', updated_at: new Date() })
      .where('id', '=', charge.id)
      .execute();
  }
}

function toResponse(
  charge: { order_id: string; status: BankQrChargeStatus; due_date: string },
  orderId: string,
): QrChargeResponse {
  return {
    orderId,
    status: charge.status,
    qrImageUrl: `/orders/${orderId}/qr-image`,
    dueDate: charge.due_date,
  };
}

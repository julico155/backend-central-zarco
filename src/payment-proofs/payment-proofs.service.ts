import { Inject, Injectable, NotImplementedException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database, PaymentProofRoutingException } from '../database/types';
import { NotFoundDomainError } from '../common/exceptions/domain-exception';

export interface PaymentProofResponse {
  id: string;
  orderId: string | null;
  attemptId: string | null;
  matchMethod: string;
  routingException: string | null;
  captureStatus: string;
  createdAt: string;
}

/**
 * Comprobantes de pago. ESQUELETO: las bandejas de excepciones/no asignados
 * (lectura, bajo riesgo) están implementadas; el intake atómico
 * (idempotencia por source_message_id -> resolver pedido -> crear/unir
 * payment_attempts -> guardar archivo en S3/R2) y el streaming autenticado
 * del archivo quedan pendientes de la fase de pagos (fase 5 del plan) y de
 * decidir el proveedor de storage.
 */
@Injectable()
export class PaymentProofsService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async findWithRoutingException(
    exception?: PaymentProofRoutingException,
  ): Promise<PaymentProofResponse[]> {
    let query = this.db
      .selectFrom('payment_proofs')
      .selectAll()
      .where('routing_exception', 'is not', null);
    if (exception) query = query.where('routing_exception', '=', exception);
    const rows = await query.orderBy('created_at', 'desc').execute();
    return rows.map(toResponse);
  }

  async findUnassigned(matchMethod?: string): Promise<PaymentProofResponse[]> {
    let query = this.db.selectFrom('payment_proofs').selectAll().where('order_id', 'is', null);
    if (matchMethod) query = query.where('match_method', '=', matchMethod as never);
    const rows = await query.orderBy('created_at', 'desc').execute();
    return rows.map(toResponse);
  }

  async assign(id: string, orderId: string): Promise<PaymentProofResponse> {
    // Reglas de asignabilidad (no confundir con "aprobar") pendientes de
    // portar — por ahora solo enlaza order_id si el proof existe y no tiene
    // uno ya asignado con un motivo de excepción distinto.
    const row = await this.db
      .updateTable('payment_proofs')
      .set({ order_id: orderId, updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundDomainError('payment_proof', id);
    return toResponse(row);
  }

  async intake(): Promise<PaymentProofResponse> {
    throw new NotImplementedException(
      'POST /payment-proofs pendiente — intake atómico + storage S3/R2 (fase de pagos).',
    );
  }

  async streamFile(): Promise<never> {
    throw new NotImplementedException(
      'GET /payment-proofs/:id/file pendiente (streaming autenticado).',
    );
  }
}

function toResponse(row: {
  id: string;
  order_id: string | null;
  attempt_id: string | null;
  match_method: string;
  routing_exception: string | null;
  capture_status: string;
  created_at: Date | string;
}): PaymentProofResponse {
  return {
    id: row.id,
    orderId: row.order_id,
    attemptId: row.attempt_id,
    matchMethod: row.match_method,
    routingException: row.routing_exception,
    captureStatus: row.capture_status,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

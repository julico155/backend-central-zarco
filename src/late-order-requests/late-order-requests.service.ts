import { Inject, Injectable, NotImplementedException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { NotFoundDomainError } from '../common/exceptions/domain-exception';

export interface LateOrderRequestResponse {
  id: string;
  requestNumber: string;
  customerId: string | null;
  customerName: string;
  status: string;
  subtotalAmount: number;
  requestedAt: string;
  expiresAt: string;
  orderId: string | null;
}

/**
 * ESQUELETO: la creación la dispara internamente OrdersService.create al
 * caer en ventana late_review — no hay un DTO público de creación todavía
 * porque depende de que orders.create exista (fase 3 antes que fase 6, ver
 * plan). accept/reject quedan como stubs con el contrato transaccional
 * exacto que hay que respetar.
 */
@Injectable()
export class LateOrderRequestsService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async findById(id: string): Promise<LateOrderRequestResponse> {
    const row = await this.db
      .selectFrom('late_order_requests')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundDomainError('late_order_request', id);
    return toResponse(row);
  }

  /**
   * TODO: en una sola transacción — bloquear la solicitud (WHERE status =
   * 'pending', mismo espíritu de CAS que payment_attempts), crear el pedido
   * real reusando el mismo camino que OrdersService.create, enlazar
   * order_id, y solo entonces marcar status='accepted'. Si algo falla, todo
   * se revierte (nunca "aceptada sin pedido" — constraint
   * late_order_requests_order_only_when_accepted ya lo garantiza a nivel de
   * esquema, pero la transacción de aplicación tiene que respetarlo).
   * Luego: avisar al mostrador (Telegram, editando el mensaje de alerta
   * original) y al cliente (WhatsApp) vía NotificationsOutService.
   */
  async accept(_id: string, _decidedBy: string): Promise<LateOrderRequestResponse> {
    throw new NotImplementedException('POST /late-order-requests/:id/accept pendiente.');
  }

  async reject(
    _id: string,
    _decidedBy: string,
    _reason?: string,
  ): Promise<LateOrderRequestResponse> {
    throw new NotImplementedException('POST /late-order-requests/:id/reject pendiente.');
  }
}

function toResponse(row: {
  id: string;
  request_number: string;
  customer_id: string | null;
  customer_name: string;
  status: string;
  subtotal_amount: string;
  requested_at: Date | string;
  expires_at: Date | string;
  order_id: string | null;
}): LateOrderRequestResponse {
  return {
    id: row.id,
    requestNumber: row.request_number,
    customerId: row.customer_id,
    customerName: row.customer_name,
    status: row.status,
    subtotalAmount: Number(row.subtotal_amount),
    requestedAt: new Date(row.requested_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    orderId: row.order_id,
  };
}

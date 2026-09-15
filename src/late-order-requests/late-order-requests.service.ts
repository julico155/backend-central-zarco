import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database, LateOrderRequestStatus } from '../database/types';
import { DomainException, NotFoundDomainError } from '../common/exceptions/domain-exception';
import { NotificationsOutService } from '../notifications-out/notifications-out.service';
import { OrdersService } from '../orders/orders.service';

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

type AcceptOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'repeated'; response: LateOrderRequestResponse }
  | { outcome: 'already_settled'; status: string }
  | { outcome: 'expired' }
  | { outcome: 'order_unavailable'; reasonCode: string }
  | { outcome: 'accepted'; response: LateOrderRequestResponse; customerId: string | null };

/**
 * Portado de `decide_late_order_request` / `accept_late_order_request`
 * (saas_smarky, `0029_promotions.sql`). `accept` bloquea, revalida el
 * carrito ENTERO por el mismo camino que un checkout normal
 * (OrdersService.createOrderInTransaction) y solo entonces marca
 * 'accepted' con su order_id — todo en una transacción, para que nunca
 * quede "aceptada sin pedido".
 */
@Injectable()
export class LateOrderRequestsService {
  private readonly logger = new Logger(LateOrderRequestsService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly ordersService: OrdersService,
    private readonly notifications: NotificationsOutService,
  ) {}

  async findById(id: string): Promise<LateOrderRequestResponse> {
    const row = await this.db
      .selectFrom('late_order_requests')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundDomainError('late_order_request', id);
    return toResponse(row);
  }

  /** Cola de solicitudes para el dashboard — por defecto solo las 'pending'. */
  async findMany(filter: {
    status?: LateOrderRequestStatus;
    limit?: number;
    offset?: number;
  }): Promise<LateOrderRequestResponse[]> {
    const rows = await this.db
      .selectFrom('late_order_requests')
      .selectAll()
      .where('status', '=', filter.status ?? 'pending')
      .orderBy('requested_at', 'asc')
      .limit(Math.min(filter.limit ?? 50, 200))
      .offset(filter.offset ?? 0)
      .execute();
    return rows.map(toResponse);
  }

  async accept(id: string, decidedBy: string): Promise<LateOrderRequestResponse> {
    const decidedAt = new Date();

    const result = await this.db.transaction().execute(async (trx): Promise<AcceptOutcome> => {
      const req = await trx
        .selectFrom('late_order_requests')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!req) return { outcome: 'not_found' };

      if (req.status !== 'pending') {
        if (req.status === 'accepted') return { outcome: 'repeated', response: toResponse(req) };
        return { outcome: 'already_settled', status: req.status };
      }

      if (new Date(req.expires_at) <= decidedAt) {
        await trx
          .updateTable('late_order_requests')
          .set({
            status: 'expired',
            decided_at: decidedAt,
            decided_by: 'system',
            updated_at: decidedAt,
          })
          .where('id', '=', id)
          .execute();
        return { outcome: 'expired' };
      }

      // Los fallos permanentes (producto/promo caídos, etc.) NO se
      // reintentan: se atrapan y la solicitud queda 'rejected' con motivo
      // propio — nunca un bucle. SAVEPOINT explícito (no confiar en que
      // createOrderInTransaction valide todo ANTES de escribir): si algo
      // ahí dentro escribe y LUEGO falla, esto deshace exactamente eso, sin
      // tirar abajo la transacción completa (que también bloquea la fila
      // de late_order_requests).
      await sql`savepoint sp_checkout`.execute(trx);
      try {
        const order = await this.ordersService.createOrderInTransaction(trx, {
          customerId: req.customer_id,
          channel: req.channel,
          customerName: req.customer_name,
          deliveryType: req.delivery_type,
          paymentMethod: req.payment_method,
          notes: req.notes,
          items: req.items_json as unknown as { productId: string; quantity: number }[],
          promotions: req.promotions_json as unknown as {
            promotionId: string;
            quantity: number;
            revision: number;
          }[],
        });

        const updated = await trx
          .updateTable('late_order_requests')
          .set({
            status: 'accepted',
            decided_at: decidedAt,
            decided_by: decidedBy,
            order_id: order.id,
            updated_at: decidedAt,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();

        await sql`release savepoint sp_checkout`.execute(trx);
        return { outcome: 'accepted', response: toResponse(updated), customerId: req.customer_id };
      } catch (error) {
        if (error instanceof DomainException) {
          await sql`rollback to savepoint sp_checkout`.execute(trx);
          await trx
            .updateTable('late_order_requests')
            .set({
              status: 'rejected',
              decided_at: decidedAt,
              decided_by: decidedBy,
              updated_at: decidedAt,
            })
            .where('id', '=', id)
            .execute();
          return { outcome: 'order_unavailable', reasonCode: error.code };
        }
        throw error; // error inesperado: revierte TODO, incluida la expiración de arriba si aplicara
      }
    });

    switch (result.outcome) {
      case 'not_found':
        throw new NotFoundDomainError('late_order_request', id);
      case 'repeated':
        return result.response;
      case 'already_settled':
        throw new DomainException(
          'already_settled',
          HttpStatus.CONFLICT,
          `La solicitud ya fue decidida (status=${result.status}).`,
        );
      case 'expired':
        throw new DomainException(
          'late_order_request_expired',
          HttpStatus.CONFLICT,
          'La solicitud venció antes de poder aceptarse.',
        );
      case 'order_unavailable':
        this.notifyCustomerBestEffort(
          id,
          null,
          'No pudimos confirmar tu pedido, el carrito ya no está disponible.',
        );
        throw new DomainException(
          'order_unavailable',
          HttpStatus.CONFLICT,
          'El pedido ya no se puede crear con el carrito original (producto o promoción caídos).',
          { reasonCode: result.reasonCode },
        );
      case 'accepted':
        this.notifyCustomerBestEffort(
          id,
          result.customerId,
          `Tu pedido fue aceptado: ${result.response.orderId}.`,
        );
        return result.response;
    }
  }

  async reject(id: string, decidedBy: string, _reason?: string): Promise<LateOrderRequestResponse> {
    const decidedAt = new Date();
    const updated = await this.db
      .updateTable('late_order_requests')
      .set({
        status: 'rejected',
        decided_at: decidedAt,
        decided_by: decidedBy,
        updated_at: decidedAt,
      })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .returningAll()
      .executeTakeFirst();

    if (updated) {
      this.notifyCustomerBestEffort(
        id,
        updated.customer_id,
        'Tu pedido no pudo confirmarse fuera de horario.',
      );
      return toResponse(updated);
    }

    const existing = await this.db
      .selectFrom('late_order_requests')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!existing) throw new NotFoundDomainError('late_order_request', id);
    if (existing.status === 'rejected') return toResponse(existing);
    throw new DomainException(
      'already_settled',
      HttpStatus.CONFLICT,
      `La solicitud ya fue decidida (status=${existing.status}).`,
    );
  }

  private notifyCustomerBestEffort(
    requestId: string,
    customerId: string | null,
    text: string,
  ): void {
    if (!customerId) return;
    this.notifications
      .notifyNow({
        channel: 'whatsapp',
        kind: 'late_request_decision',
        targetRef: requestId,
        payload: { customerId, text },
      })
      .catch((error: Error) =>
        this.logger.warn(`No se pudo notificar desenlace de ${requestId}: ${error.message}`),
      );
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

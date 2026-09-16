import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Kysely, sql, Transaction } from 'kysely';
import { KYSELY } from '../database/database.module';
import { CashRegisterSessionStatus, Database } from '../database/types';
import { DomainException, NotFoundDomainError } from '../common/exceptions/domain-exception';

export interface CashRegisterSessionResponse {
  id: string;
  status: CashRegisterSessionStatus;
  openedAt: string;
  openedBy: string;
  openingAmount: number;
  closedAt: string | null;
  closedBy: string | null;
  countedCashAmount: number | null;
  expectedCashAmount: number | null;
  cashDifference: number | null;
  totalCashSalesAmount: number | null;
  totalQrSalesAmount: number | null;
  totalSalesAmount: number | null;
  notes: string | null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

/**
 * Caja (turno). Una sola sesión `status='open'` a la vez para todo el local
 * (índice único parcial en la migración) — cubre efectivo y QR por igual,
 * no solo plata física: agrupa cualquier pedido confirmado pagado durante
 * la sesión. El rango opened_at..closed_at ES el "día de negocio" (el local
 * cruza medianoche, así que no hay una fecha calendario que lo represente).
 */
@Injectable()
export class CashRegisterService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async open(openingAmount: number, openedBy: string): Promise<CashRegisterSessionResponse> {
    try {
      const row = await this.db
        .insertInto('cash_register_sessions')
        .values({ opening_amount: openingAmount.toFixed(2), opened_by: openedBy })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toResponse(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainException(
          'cash_register_already_open',
          HttpStatus.CONFLICT,
          'Ya hay una caja abierta.',
        );
      }
      throw error;
    }
  }

  async close(
    countedCashAmount: number,
    notes: string | undefined,
    closedBy: string,
  ): Promise<CashRegisterSessionResponse> {
    return this.db.transaction().execute(async (trx) => {
      const open = await trx
        .selectFrom('cash_register_sessions')
        .selectAll()
        .where('status', '=', 'open')
        .forUpdate()
        .executeTakeFirst();
      if (!open) {
        throw new DomainException(
          'cash_register_not_open',
          HttpStatus.CONFLICT,
          'No hay ninguna caja abierta para cerrar.',
        );
      }

      const sums = await trx
        .selectFrom('orders')
        .select(['payment_method', sql<string>`coalesce(sum(total_amount), 0)`.as('total')])
        .where('register_session_id', '=', open.id)
        .groupBy('payment_method')
        .execute();
      const totalCash = Number(sums.find((s) => s.payment_method === 'cash')?.total ?? 0);
      const totalQr = Number(sums.find((s) => s.payment_method === 'qr')?.total ?? 0);
      const expectedCash = Number(open.opening_amount) + totalCash;
      const difference = countedCashAmount - expectedCash;

      const updated = await trx
        .updateTable('cash_register_sessions')
        .set({
          status: 'closed',
          closed_at: new Date(),
          closed_by: closedBy,
          counted_cash_amount: countedCashAmount.toFixed(2),
          expected_cash_amount: expectedCash.toFixed(2),
          cash_difference: difference.toFixed(2),
          total_cash_sales_amount: totalCash.toFixed(2),
          total_qr_sales_amount: totalQr.toFixed(2),
          total_sales_amount: (totalCash + totalQr).toFixed(2),
          notes: notes ?? null,
        })
        .where('id', '=', open.id)
        .returningAll()
        .executeTakeFirstOrThrow();

      return toResponse(updated);
    });
  }

  async getCurrent(): Promise<CashRegisterSessionResponse | null> {
    const row = await this.db
      .selectFrom('cash_register_sessions')
      .selectAll()
      .where('status', '=', 'open')
      .executeTakeFirst();
    return row ? toResponse(row) : null;
  }

  async getById(id: string): Promise<CashRegisterSessionResponse> {
    const row = await this.db
      .selectFrom('cash_register_sessions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundDomainError('cash_register_session', id);
    return toResponse(row);
  }

  async findMany(limit?: number, offset?: number): Promise<CashRegisterSessionResponse[]> {
    const rows = await this.db
      .selectFrom('cash_register_sessions')
      .selectAll()
      .orderBy('opened_at', 'desc')
      .limit(Math.min(limit ?? 50, 200))
      .offset(offset ?? 0)
      .execute();
    return rows.map(toResponse);
  }

  /**
   * Usado por orders/payment-attempts/late-order-requests para vincular un
   * pedido a la caja en el momento exacto en que su pago se confirma (o, si
   * es un pedido fuera de horario, al aceptarlo). Acepta tanto la conexión
   * suelta como una transacción ajena, para poder llamarse dentro de la
   * transacción de quien pide el id.
   */
  async assertOpenSessionId(db: Kysely<Database> | Transaction<Database>): Promise<string> {
    const open = await db
      .selectFrom('cash_register_sessions')
      .select('id')
      .where('status', '=', 'open')
      .executeTakeFirst();
    if (!open) {
      throw new DomainException(
        'cash_register_closed',
        HttpStatus.CONFLICT,
        'No hay una caja abierta. Abrí la caja antes de confirmar este pago.',
      );
    }
    return open.id;
  }
}

function toResponse(row: {
  id: string;
  status: CashRegisterSessionStatus;
  opened_at: Date | string;
  opened_by: string;
  opening_amount: string;
  closed_at: Date | string | null;
  closed_by: string | null;
  counted_cash_amount: string | null;
  expected_cash_amount: string | null;
  cash_difference: string | null;
  total_cash_sales_amount: string | null;
  total_qr_sales_amount: string | null;
  total_sales_amount: string | null;
  notes: string | null;
}): CashRegisterSessionResponse {
  return {
    id: row.id,
    status: row.status,
    openedAt: new Date(row.opened_at).toISOString(),
    openedBy: row.opened_by,
    openingAmount: Number(row.opening_amount),
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
    closedBy: row.closed_by,
    countedCashAmount: row.counted_cash_amount === null ? null : Number(row.counted_cash_amount),
    expectedCashAmount: row.expected_cash_amount === null ? null : Number(row.expected_cash_amount),
    cashDifference: row.cash_difference === null ? null : Number(row.cash_difference),
    totalCashSalesAmount:
      row.total_cash_sales_amount === null ? null : Number(row.total_cash_sales_amount),
    totalQrSalesAmount: row.total_qr_sales_amount === null ? null : Number(row.total_qr_sales_amount),
    totalSalesAmount: row.total_sales_amount === null ? null : Number(row.total_sales_amount),
    notes: row.notes,
  };
}

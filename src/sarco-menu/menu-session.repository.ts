import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';

export interface MenuSession {
  id: string;
  sourceMessageId: string;
  tokenHash: string;
  customerPhone: string;
  phoneNumberId: string;
  expiresAt: string;
  replacesOrderId: string | null;
}

export interface CreateMenuSessionInput {
  sourceMessageId: string;
  tokenHash: string;
  customerPhone: string;
  phoneNumberId: string;
  replacesOrderId: string | null;
}

/** El `source_message_id` de la sesión existente no coincide con lo que se está creando ahora. */
export class MenuSessionIntegrityError extends Error {
  constructor() {
    super('menu_session_integrity_mismatch');
    this.name = 'MenuSessionIntegrityError';
  }
}

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function toSession(row: {
  id: string;
  source_message_id: string;
  token_hash: string;
  customer_phone: string;
  phone_number_id: string;
  expires_at: Date | string;
  replaces_order_id: string | null;
}): MenuSession {
  return {
    id: row.id,
    sourceMessageId: row.source_message_id,
    tokenHash: row.token_hash,
    customerPhone: row.customer_phone,
    phoneNumberId: row.phone_number_id,
    expiresAt: new Date(row.expires_at).toISOString(),
    replacesOrderId: row.replaces_order_id,
  };
}

/**
 * Repositorio de `menu_sessions`. Puerto directo de sarcoRestaurant
 * (src/lib/menu/session-repository.ts + session-service.ts): crear vs.
 * reutilizar, con recuperación de conflicto por `source_message_id` y
 * verificación de integridad.
 */
@Injectable()
export class MenuSessionRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async findByHash(
    tokenHash: string,
    now: () => string = () => new Date().toISOString(),
  ): Promise<MenuSession | null> {
    const row = await this.db
      .selectFrom('menu_sessions')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .where('expires_at', '>', new Date(now()))
      .executeTakeFirst();
    return row ? toSession(row) : null;
  }

  /** Sesión vigente más reciente para ESTE teléfono que todavía no reemplaza un pedido. */
  async findValidByPhone(
    customerPhone: string,
    now: () => string = () => new Date().toISOString(),
  ): Promise<MenuSession | null> {
    const row = await this.db
      .selectFrom('menu_sessions')
      .selectAll()
      .where('customer_phone', '=', customerPhone)
      .where('expires_at', '>', new Date(now()))
      .where('replaces_order_id', 'is', null)
      .orderBy('expires_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ? toSession(row) : null;
  }

  /**
   * INSERT ... ON CONFLICT (source_message_id) DO NOTHING. Si ya existía (por
   * una reentrega del mismo WAMID), se recupera la fila y se verifica que sea
   * exactamente la misma sesión — token, teléfono, phone_number_id y
   * replacesOrderId — antes de devolverla. Un desacuerdo es un dato corrupto
   * o un intento de reutilizar el WAMID para otra sesión: se rechaza.
   */
  async getOrCreate(input: CreateMenuSessionInput): Promise<MenuSession> {
    const inserted = await this.db
      .insertInto('menu_sessions')
      .values({
        source_message_id: input.sourceMessageId,
        token_hash: input.tokenHash,
        customer_phone: input.customerPhone,
        phone_number_id: input.phoneNumberId,
        replaces_order_id: input.replacesOrderId,
      })
      .onConflict((oc) => oc.column('source_message_id').doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted) return toSession(inserted);

    const existing = await this.db
      .selectFrom('menu_sessions')
      .selectAll()
      .where('source_message_id', '=', input.sourceMessageId)
      .executeTakeFirstOrThrow();

    if (
      existing.token_hash !== input.tokenHash ||
      existing.customer_phone !== input.customerPhone ||
      existing.phone_number_id !== input.phoneNumberId ||
      existing.replaces_order_id !== input.replacesOrderId
    ) {
      throw new MenuSessionIntegrityError();
    }

    return toSession(existing);
  }

  /** Reutilizar una sesión válida le renueva el vencimiento a 2h desde ahora. */
  async renewExpiry(
    id: string,
    now: () => string = () => new Date().toISOString(),
  ): Promise<string> {
    const expiresAt = new Date(new Date(now()).getTime() + SESSION_TTL_MS);
    await this.db
      .updateTable('menu_sessions')
      .set({ expires_at: expiresAt })
      .where('id', '=', id)
      .execute();
    return expiresAt.toISOString();
  }
}

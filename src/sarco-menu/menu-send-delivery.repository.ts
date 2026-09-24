import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database, MenuSendDeliveryReason, MenuSendDeliveryStatus } from '../database/types';

export type ClaimMenuSendDeliveryResult = { claimed: true; id: string } | { claimed: false };

export interface FinishMenuSendDeliveryInput {
  id: string;
  status: Exclude<MenuSendDeliveryStatus, 'pending'>;
  providerMessageId?: string | null;
  errorCode?: string | null;
}

/**
 * Repositorio del ledger `menu_send_deliveries`. Puerto directo de
 * sarcoRestaurant (src/lib/menu/delivery-repository.ts): idempotencia
 * TÉCNICA del envío del CTA (por WAMID del entrante que lo disparó, nunca
 * por sesión) y ventana de eco reciente.
 */
@Injectable()
export class MenuSendDeliveryRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /** INSERT ... ON CONFLICT (source_message_id) DO NOTHING — atómico. */
  async claim(
    sourceMessageId: string,
    customerPhone: string,
    reason: MenuSendDeliveryReason,
  ): Promise<ClaimMenuSendDeliveryResult> {
    const inserted = await this.db
      .insertInto('menu_send_deliveries')
      .values({
        source_message_id: sourceMessageId,
        customer_phone: customerPhone,
        reason,
        status: 'pending',
      })
      .onConflict((oc) => oc.column('source_message_id').doNothing())
      .returning('id')
      .executeTakeFirst();

    return inserted ? { claimed: true, id: inserted.id } : { claimed: false };
  }

  async finish(input: FinishMenuSendDeliveryInput): Promise<void> {
    await this.db
      .updateTable('menu_send_deliveries')
      .set({
        status: input.status,
        provider_message_id: input.providerMessageId ?? null,
        error_code: input.errorCode ?? null,
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where('id', '=', input.id)
      .execute();
  }

  /** Último envío `sent` a este teléfono, para la ventana de eco (30 s). */
  async lastSentAt(customerPhone: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('menu_send_deliveries')
      .select('completed_at')
      .where('customer_phone', '=', customerPhone)
      .where('status', '=', 'sent')
      .orderBy('completed_at', 'desc')
      .limit(1)
      .executeTakeFirst();

    return row?.completed_at ? new Date(row.completed_at).toISOString() : null;
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { AGENT_KYSELY } from '../database/agent-database.module';
import {
  AgentDatabase,
  MenuSendDeliveryReason,
  MenuSendDeliveryStatus,
} from '../database/agent-types';

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
  constructor(@Inject(AGENT_KYSELY) private readonly db: Kysely<AgentDatabase>) {}

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
        // Reloj de la BASE, no el del proceso: `claimed_at` nace con `now()` de la DB y el CHECK
        // `completed_at >= claimed_at` rechaza el cierre si el reloj de esta máquina va atrasado.
        // Un cierre rechazado deja el ledger en `pending` para siempre.
        completed_at: sql`now()`,
        updated_at: sql`now()`,
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

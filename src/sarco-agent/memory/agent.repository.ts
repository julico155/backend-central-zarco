import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { AGENT_KYSELY } from '../../database/agent-database.module';
import { AgentDatabase } from '../../database/agent-types';
import { toAutomationAction, type ContextMessage } from '../core/context';
import type {
  AgentConversationRef,
  AgentPauseState,
  AgentRunStore,
  AgentStore,
  ClaimAgentRunInput,
  ClaimAgentRunResult,
  FinishAgentRunInput,
  InsertAgentMessageInput,
  InsertControlEventInput,
  InsertControlEventResult,
  InsertMessageResult,
  PauseConversationInput,
  PauseConversationResult,
  RenewPauseInput,
  RenewPauseResult,
  ResumeConversationInput,
  ResumeConversationResult,
  UpsertConversationInput,
} from '../core/types';

/** Código Postgres de violación de unicidad. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/**
 * Repositorio de las tablas `agent_*` sobre Kysely/Postgres. Puerto directo
 * de sarcoRestaurant (src/lib/agent/memory/repository.ts, Fase 6D.2F.2B),
 * reescrito de Supabase (PostgREST) a Kysely — misma semántica exacta:
 *
 *  - `agent_conversations.customer_phone` UNIQUE  → upsert por identidad durable;
 *  - `agent_messages.provider_message_id` UNIQUE parcial → dedupe de wamid;
 *  - `agent_control_events` UNIQUE parcial (conversación, action, wamid).
 *
 * `last_message_at` NO tiene trigger en Backend Central (a diferencia de
 * 0014 en Supabase): se mantiene aquí mismo, en la MISMA sentencia que avanza
 * el `last_*` del actor — ver `advanceTimestamp`.
 */
@Injectable()
export class AgentRepository implements AgentStore, AgentRunStore {
  constructor(@Inject(AGENT_KYSELY) private readonly db: Kysely<AgentDatabase>) {}

  /**
   * Semántica `greatest`/`least` sin leer-y-recalcular: UPDATE condicionales,
   * cada uno atómico a nivel de fila y un no-op cuando el valor guardado ya
   * es mejor.
   */
  private async advanceTimestamp(
    id: string,
    column: 'last_customer_message_at' | 'last_human_message_at' | 'last_ai_message_at',
    timestamp: string,
  ): Promise<void> {
    const ts = new Date(timestamp);

    // Primer mensaje de ese actor.
    await this.db
      .updateTable('agent_conversations')
      .set({ [column]: ts, last_message_at: ts, updated_at: new Date() } as never)
      .where('id', '=', id)
      .where(column, 'is', null)
      .execute();

    // greatest(actual, entrante): solo avanza, nunca retrocede. `last_message_at`
    // avanza en la misma sentencia porque, si este `last_*` avanzó, es por
    // construcción el candidato más reciente conocido en este momento.
    await this.db
      .updateTable('agent_conversations')
      .set({ [column]: ts, last_message_at: ts, updated_at: new Date() } as never)
      .where('id', '=', id)
      .where(column, '<', ts)
      .execute();
  }

  async upsertConversation(input: UpsertConversationInput): Promise<AgentConversationRef> {
    const values: Record<string, unknown> = { customer_phone: input.customerPhone };
    if (input.providerConversationId !== null) {
      values.last_provider_conversation_id = input.providerConversationId;
    }
    if (input.providerPhoneNumberId !== null) {
      values.provider_phone_number_id = input.providerPhoneNumberId;
    }

    const row = await this.db
      .insertInto('agent_conversations')
      .values(values as never)
      .onConflict((oc) =>
        oc.column('customer_phone').doUpdateSet({
          ...(input.providerConversationId !== null
            ? { last_provider_conversation_id: input.providerConversationId }
            : {}),
          ...(input.providerPhoneNumberId !== null
            ? { provider_phone_number_id: input.providerPhoneNumberId }
            : {}),
          updated_at: new Date(),
        }),
      )
      .returning(['id', 'state'])
      .executeTakeFirstOrThrow();

    return { id: row.id, state: row.state };
  }

  async insertMessage(input: InsertAgentMessageInput): Promise<InsertMessageResult> {
    try {
      await this.db
        .insertInto('agent_messages')
        .values({
          agent_conversation_id: input.agentConversationId,
          provider_message_id: input.providerMessageId,
          provider_conversation_id: input.providerConversationId,
          direction: input.direction,
          role: input.role,
          actor: input.actor,
          content: input.content,
          content_type: input.contentType,
          metadata: input.metadata as never,
          message_timestamp: new Date(input.messageTimestamp),
        })
        .execute();
      return 'inserted';
    } catch (error) {
      if (isUniqueViolation(error)) return 'duplicate';
      throw error;
    }
  }

  async touchCustomerMessageAt(id: string, timestamp: string): Promise<void> {
    const ts = new Date(timestamp);

    // El CHECK de coherencia exige first/last ambos NULL o ambos no-NULL: la
    // inicialización fija LOS DOS en la misma sentencia.
    await this.db
      .updateTable('agent_conversations')
      .set({
        first_customer_message_at: ts,
        last_customer_message_at: ts,
        last_message_at: ts,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .where('first_customer_message_at', 'is', null)
      .execute();

    await this.advanceTimestamp(id, 'last_customer_message_at', timestamp);

    // least(actual, entrante): una reentrega tardía sí puede retroceder `first`.
    await this.db
      .updateTable('agent_conversations')
      .set({ first_customer_message_at: ts, updated_at: new Date() })
      .where('id', '=', id)
      .where('first_customer_message_at', '>', ts)
      .execute();
  }

  async touchHumanMessageAt(id: string, timestamp: string): Promise<void> {
    await this.advanceTimestamp(id, 'last_human_message_at', timestamp);
  }

  async pauseConversation(input: PauseConversationInput): Promise<PauseConversationResult> {
    const rows = await this.db
      .updateTable('agent_conversations')
      .set({
        state: 'paused',
        paused_at: new Date(input.pausedAt),
        pause_expires_at: input.pauseExpiresAt === null ? null : new Date(input.pauseExpiresAt),
        pause_reason: input.reason,
        pause_source: input.source,
        resumed_at: null,
        updated_at: new Date(),
      })
      .where('id', '=', input.agentConversationId)
      .where('state', '=', 'active')
      .returning('id')
      .execute();

    return rows.length > 0 ? 'paused' : 'already_paused';
  }

  async renewPause(input: RenewPauseInput): Promise<RenewPauseResult> {
    const newExpiry = new Date(input.pauseExpiresAt);

    // Monotonía: solo se escribe si el vencimiento nuevo es posterior al
    // guardado (o si no había ninguno). Los cuatro guards son el contrato
    // entero: conversación pausada, MISMO reason/source, y más largo.
    const renewed = await this.db
      .updateTable('agent_conversations')
      .set({ pause_expires_at: newExpiry, updated_at: new Date() })
      .where('id', '=', input.agentConversationId)
      .where('state', '=', 'paused')
      .where('pause_reason', '=', input.reason)
      .where('pause_source', '=', input.source)
      .where((eb) =>
        eb.or([eb('pause_expires_at', 'is', null), eb('pause_expires_at', '<', newExpiry)]),
      )
      .returning('id')
      .execute();

    if (renewed.length > 0) return 'renewed';

    const alive = await this.db
      .selectFrom('agent_conversations')
      .select('id')
      .where('id', '=', input.agentConversationId)
      .where('state', '=', 'paused')
      .where('pause_reason', '=', input.reason)
      .where('pause_source', '=', input.source)
      .limit(1)
      .execute();

    return alive.length > 0 ? 'not_extended' : 'not_renewable';
  }

  async resumeConversation(input: ResumeConversationInput): Promise<ResumeConversationResult> {
    const rows = await this.db
      .updateTable('agent_conversations')
      .set({
        state: 'active',
        paused_at: null,
        pause_expires_at: null,
        pause_reason: null,
        pause_source: null,
        resumed_at: new Date(input.resumedAt),
        updated_at: new Date(),
      })
      .where('id', '=', input.agentConversationId)
      .where('state', '=', 'paused')
      .returning('id')
      .execute();

    return rows.length > 0 ? 'resumed' : 'already_active';
  }

  async hasResumeEvent(id: string, resumedAt: string): Promise<boolean> {
    const rows = await this.db
      .selectFrom('agent_control_events')
      .select('id')
      .where('agent_conversation_id', '=', id)
      .where('action', '=', 'resume')
      .where(sql<boolean>`metadata ->> 'resumed_at' = ${resumedAt}`)
      .limit(1)
      .execute();

    return rows.length > 0;
  }

  async hasPauseEventForMessage(id: string, providerMessageId: string): Promise<boolean> {
    const rows = await this.db
      .selectFrom('agent_control_events')
      .select('id')
      .where('agent_conversation_id', '=', id)
      .where('action', '=', 'pause')
      .where('provider_message_id', '=', providerMessageId)
      .limit(1)
      .execute();

    return rows.length > 0;
  }

  async insertControlEvent(input: InsertControlEventInput): Promise<InsertControlEventResult> {
    try {
      await this.db
        .insertInto('agent_control_events')
        .values({
          agent_conversation_id: input.agentConversationId,
          action: input.action,
          source: input.source,
          reason: input.reason,
          provider_message_id: input.providerMessageId,
          expires_at: input.expiresAt ? new Date(input.expiresAt) : null,
          metadata: input.metadata as never,
        })
        .execute();
      return 'inserted';
    } catch (error) {
      if (isUniqueViolation(error)) return 'duplicate';
      throw error;
    }
  }

  // ── Ciclo de ejecución (AgentRunStore) ────────────────────────────────────

  async claimRun(input: ClaimAgentRunInput): Promise<ClaimAgentRunResult> {
    const inserted = await this.db
      .insertInto('agent_runs')
      .values({
        agent_conversation_id: input.agentConversationId,
        source_message_id: input.sourceMessageId,
        source_agent_message_id: input.sourceAgentMessageId,
        model: input.model,
        status: 'processing',
      })
      .onConflict((oc) => oc.column('source_message_id').doNothing())
      .returning('id')
      .execute();

    if (inserted.length > 0) {
      return { result: 'claimed', runId: inserted[0].id };
    }

    const existing = await this.db
      .selectFrom('agent_runs')
      .select(['id', 'status'])
      .where('source_message_id', '=', input.sourceMessageId)
      .executeTakeFirstOrThrow();

    return { result: 'exists', runId: existing.id, status: existing.status };
  }

  async markRunSending(runId: string): Promise<void> {
    await this.db
      .updateTable('agent_runs')
      .set({ status: 'sending', updated_at: new Date() })
      .where('id', '=', runId)
      .where('status', '=', 'processing')
      .execute();
  }

  async finishRun(input: FinishAgentRunInput): Promise<void> {
    const payload: Record<string, unknown> = {
      status: input.status,
      completed_at: new Date(input.completedAt),
      response_message_id: input.responseMessageId ?? null,
      error_code: input.errorCode ?? null,
      skipped_at_barrier: input.skippedAtBarrier ?? null,
      updated_at: new Date(),
    };
    if (input.model !== undefined && input.model !== null) payload.model = input.model;
    if (input.toolRounds !== undefined) payload.tool_rounds = input.toolRounds;

    await this.db
      .updateTable('agent_runs')
      .set(payload as never)
      .where('id', '=', input.runId)
      .execute();
  }

  async loadRecentMessages(
    agentConversationId: string,
    sinceIso: string,
    limit: number,
  ): Promise<ContextMessage[]> {
    const rows = await this.db
      .selectFrom('agent_messages')
      .select(['actor', 'role', 'content', 'content_type', 'message_timestamp', 'metadata'])
      .where('agent_conversation_id', '=', agentConversationId)
      .where('message_timestamp', '>=', new Date(sinceIso))
      .orderBy('message_timestamp', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();

    return rows
      .map((row) => {
        const metadata = row.metadata as Record<string, unknown> | null;
        return {
          actor: row.actor,
          role: row.role,
          content: row.content,
          contentType: row.content_type,
          messageTimestamp: new Date(row.message_timestamp).toISOString(),
          automationAction:
            row.actor === 'automation' ? toAutomationAction(metadata?.action) : null,
        };
      })
      .reverse();
  }

  async findMessageIdByProviderMessageId(providerMessageId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('agent_messages')
      .select('id')
      .where('provider_message_id', '=', providerMessageId)
      .executeTakeFirst();

    return row?.id ?? null;
  }

  async touchAiMessageAt(id: string, timestamp: string): Promise<void> {
    const ts = new Date(timestamp);

    await this.db
      .updateTable('agent_conversations')
      .set({
        first_ai_message_at: ts,
        last_ai_message_at: ts,
        last_message_at: ts,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .where('first_ai_message_at', 'is', null)
      .execute();

    await this.advanceTimestamp(id, 'last_ai_message_at', timestamp);

    await this.db
      .updateTable('agent_conversations')
      .set({ first_ai_message_at: ts, updated_at: new Date() })
      .where('id', '=', id)
      .where('first_ai_message_at', '>', ts)
      .execute();
  }

  async findPauseStateByPhone(customerPhone: string): Promise<AgentPauseState | null> {
    const row = await this.db
      .selectFrom('agent_conversations')
      .select([
        'id',
        'state',
        'paused_at',
        'pause_expires_at',
        'pause_reason',
        'pause_source',
        'resumed_at',
      ])
      .where('customer_phone', '=', customerPhone)
      .executeTakeFirst();

    if (!row) return null;

    return {
      conversationId: row.id,
      state: row.state,
      pausedAt: row.paused_at ? new Date(row.paused_at).toISOString() : null,
      pauseExpiresAt: row.pause_expires_at ? new Date(row.pause_expires_at).toISOString() : null,
      pauseReason: row.pause_reason,
      pauseSource: row.pause_source,
      resumedAt: row.resumed_at ? new Date(row.resumed_at).toISOString() : null,
    };
  }
}

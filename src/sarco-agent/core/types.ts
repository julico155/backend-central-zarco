import type { KapsoMediaReference } from '../../kapso/kapso.types';
import type { ContextMessage } from './context';
import type { AgentEligibility } from './eligibility';
import type {
  AgentControlAction,
  AgentControlSource,
  AgentConversationState,
  AgentMessageActor,
  AgentMessageContentType,
  AgentMessageDirection,
  AgentMessageRole,
  AgentRunBarrier,
  AgentRunStatus,
} from '../../database/types';

/**
 * Contratos del Agent Core. Puerto directo de sarcoRestaurant
 * (src/lib/agent/core/types.ts, Fase 6D.2F.2B/3): el core no conoce Postgres
 * ni Kapso, recibe un `AgentStore` inyectado. La implementación real vive en
 * `../memory/agent.repository.ts`.
 */

export const PAUSE_REASON_HUMAN_BUSINESS_APP = 'human_whatsapp_business_app';
export const PAUSE_REASON_HANDOFF_REQUESTED = 'handoff_requested';
export const PAUSE_REASON_HANDOFF_SPOKEN = 'handoff_spoken';
export const PAUSE_REASON_HANDOFF_STUCK = 'handoff_stuck_customer';
export const PAUSE_REASON_PAYMENT_REVIEWED = 'payment_reviewed';
export const RESUME_REASON_MANUAL_API = 'manual_api_resume';
export const RESUME_REASON_TAKEOVER_EXPIRED = 'human_takeover_expired';

/**
 * Mensaje entrante o saliente ya normalizado, tal como lo necesita el Agent
 * Core. Equivalente reducido del `ProvenanceMessage` de sarcoRestaurant
 * (src/lib/kapso/channel/provenance.ts): esta fase no porta reacciones,
 * documentos ni el detalle de `kapso.direction/origin` — ese detalle vive en
 * el adaptador (`../kapso-message.ts`) que construye este objeto.
 */
export interface AgentInboundMessage {
  providerMessageId: string | null;
  providerConversationId: string | null;
  customerPhone: string;
  providerPhoneNumberId: string | null;
  /** ISO 8601, o `null` si el proveedor no mandó un instante interpretable. */
  messageTimestamp: string | null;
  content: string | null;
  contentType: AgentMessageContentType;
  metadata: Record<string, unknown> | null;
  image: KapsoMediaReference | null;
}

export interface AgentConversationRef {
  id: string;
  state: AgentConversationState;
}

export interface AgentPauseState {
  conversationId: string;
  state: AgentConversationState;
  pausedAt: string | null;
  pauseExpiresAt: string | null;
  pauseReason: string | null;
  pauseSource: string | null;
  resumedAt: string | null;
}

export interface UpsertConversationInput {
  customerPhone: string;
  providerConversationId: string | null;
  providerPhoneNumberId: string | null;
}

export interface InsertAgentMessageInput {
  agentConversationId: string;
  providerMessageId: string | null;
  providerConversationId: string | null;
  direction: AgentMessageDirection;
  role: AgentMessageRole;
  actor: AgentMessageActor;
  content: string | null;
  contentType: AgentMessageContentType;
  metadata: Record<string, unknown> | null;
  messageTimestamp: string;
}

export type InsertMessageResult = 'inserted' | 'duplicate';

export interface PauseConversationInput {
  agentConversationId: string;
  pausedAt: string;
  pauseExpiresAt: string | null;
  reason: string;
  source: AgentControlSource;
}

export type PauseConversationResult = 'paused' | 'already_paused';

export interface RenewPauseInput {
  agentConversationId: string;
  pauseExpiresAt: string;
  reason: string;
  source: AgentControlSource;
}

export type RenewPauseResult = 'renewed' | 'not_extended' | 'not_renewable';

export interface ResumeConversationInput {
  agentConversationId: string;
  resumedAt: string;
}

export type ResumeConversationResult = 'resumed' | 'already_active';

export interface InsertControlEventInput {
  agentConversationId: string;
  action: AgentControlAction;
  source: AgentControlSource;
  reason: string | null;
  providerMessageId: string | null;
  expiresAt?: string | null;
  metadata: Record<string, unknown> | null;
}

export type InsertControlEventResult = 'inserted' | 'duplicate';

/** Acceso a datos de las tablas `agent_*`. Ninguna operación envía mensajes ni llama a OpenAI. */
export interface AgentStore {
  upsertConversation(input: UpsertConversationInput): Promise<AgentConversationRef>;
  insertMessage(input: InsertAgentMessageInput): Promise<InsertMessageResult>;
  touchCustomerMessageAt(agentConversationId: string, timestamp: string): Promise<void>;
  touchHumanMessageAt(agentConversationId: string, timestamp: string): Promise<void>;
  pauseConversation(input: PauseConversationInput): Promise<PauseConversationResult>;
  renewPause(input: RenewPauseInput): Promise<RenewPauseResult>;
  resumeConversation(input: ResumeConversationInput): Promise<ResumeConversationResult>;
  insertControlEvent(input: InsertControlEventInput): Promise<InsertControlEventResult>;
  hasResumeEvent(agentConversationId: string, resumedAt: string): Promise<boolean>;
  hasPauseEventForMessage(agentConversationId: string, providerMessageId: string): Promise<boolean>;
  findPauseStateByPhone(customerPhone: string): Promise<AgentPauseState | null>;
}

export interface ClaimAgentRunInput {
  agentConversationId: string;
  sourceMessageId: string;
  sourceAgentMessageId: string | null;
  model: string | null;
}

export type ClaimAgentRunResult =
  | { result: 'claimed'; runId: string }
  | { result: 'exists'; runId: string; status: AgentRunStatus };

export interface FinishAgentRunInput {
  runId: string;
  status: Exclude<AgentRunStatus, 'processing' | 'sending'>;
  completedAt: string;
  responseMessageId?: string | null;
  errorCode?: string | null;
  skippedAtBarrier?: AgentRunBarrier | null;
  model?: string | null;
  toolRounds?: number;
}

export interface AgentRunStore {
  claimRun(input: ClaimAgentRunInput): Promise<ClaimAgentRunResult>;
  markRunSending(runId: string): Promise<void>;
  finishRun(input: FinishAgentRunInput): Promise<void>;
  loadRecentMessages(
    agentConversationId: string,
    sinceIso: string,
    limit: number,
  ): Promise<ContextMessage[]>;
  findMessageIdByProviderMessageId(providerMessageId: string): Promise<string | null>;
  touchAiMessageAt(agentConversationId: string, timestamp: string): Promise<void>;
}

export type AgentSendResult =
  { ok: true; wamid: string } | { ok: false; error: string; status?: number };

export interface AgentSendPort {
  sendText(
    customerPhone: string,
    text: string,
    phoneNumberId: string | null,
  ): Promise<AgentSendResult>;
}

export type TakeoverRejection = 'missing_phone' | 'missing_message_id';

export type TakeoverPauseOutcome = PauseConversationResult | 'already_applied';

export type HumanTakeoverResult =
  | {
      result: 'ok';
      conversationId: string;
      message: InsertMessageResult;
      pause: TakeoverPauseOutcome;
      controlEvent: InsertControlEventResult;
    }
  | { result: 'rejected'; reason: TakeoverRejection };

export type PersistInboundResult =
  | { result: 'persisted' | 'duplicate'; conversationId: string }
  | { result: 'rejected'; reason: 'missing_phone' };

export type ResumeAgentResult =
  | {
      result: 'ok';
      conversationId: string;
      transition: ResumeConversationResult;
      controlEvent: InsertControlEventResult;
    }
  | { result: 'not_found' }
  | { result: 'rejected'; reason: 'missing_phone' };

/** Desenlace saneado de un turno: sin teléfono, sin texto, sin prompt. */
export type AgentTurnSkipReason =
  | AgentEligibility
  | 'paused'
  | 'missing_phone'
  | 'missing_message_id'
  | 'unsupported_content'
  | 'no_conversation';

export type AgentTurnResult =
  | { result: 'skipped'; reason: AgentTurnSkipReason; runId?: string }
  | { result: 'duplicate'; runId: string; status: AgentRunStatus }
  | { result: 'replied'; runId: string }
  | { result: 'completed_silent'; runId: string }
  | { result: 'failed'; runId: string; error: string }
  | { result: 'send_unknown'; runId: string; error: string };

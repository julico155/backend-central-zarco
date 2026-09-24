import { ColumnType, Generated, JSONColumnType } from 'kysely';

/**
 * Tipos de tabla de la DB AGENTE (AGENT_DATABASE_URL), separada de la DB
 * Central (`Database`, ./types.ts). Ninguna de estas tablas existe en Central
 * y ninguna tabla de Central existe acá: por eso `menu_sessions.replaces_order_id`
 * es un uuid SIN clave foránea (un pedido vive en otra base) y por eso no
 * puede haber joins entre ambas — la comunicación va por servicios de Nest.
 */

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export type WebhookEventStatus = 'received' | 'processing' | 'processed' | 'failed';

/** Entrega autenticada de Kapso, durable antes de cualquier lógica de negocio. */
export interface WebhookEventsTable {
  id: Generated<string>;
  event_id: string;
  event_name: string;
  message_id: string | null;
  payload: JSONColumnType<Record<string, unknown>>;
  status: Generated<WebhookEventStatus>;
  claim_token: string | null;
  claimed_until: Timestamp | null;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  next_attempt_at: Timestamp | null;
  error_message: string | null;
  processed_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type AgentConversationState = 'active' | 'paused';
export type AgentControlSource = 'business_app' | 'dashboard' | 'api' | 'system';

export interface AgentConversationsTable {
  id: Generated<string>;
  customer_phone: string;
  last_provider_conversation_id: string | null;
  provider_phone_number_id: string | null;
  state: Generated<AgentConversationState>;
  paused_at: Timestamp | null;
  pause_expires_at: Timestamp | null;
  pause_reason: string | null;
  pause_source: AgentControlSource | null;
  resumed_at: Timestamp | null;
  first_customer_message_at: Timestamp | null;
  first_ai_message_at: Timestamp | null;
  last_message_at: Timestamp | null;
  last_customer_message_at: Timestamp | null;
  last_ai_message_at: Timestamp | null;
  last_human_message_at: Timestamp | null;
  last_automation_message_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type AgentMessageDirection = 'inbound' | 'outbound';
export type AgentMessageRole = 'user' | 'assistant';
export type AgentMessageActor = 'customer' | 'ai' | 'human' | 'automation';
export type AgentMessageContentType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'sticker'
  | 'location'
  | 'interactive'
  | 'unknown';

export interface AgentMessagesTable {
  id: Generated<string>;
  agent_conversation_id: string;
  provider_message_id: string | null;
  provider_conversation_id: string | null;
  direction: AgentMessageDirection;
  role: AgentMessageRole;
  actor: AgentMessageActor;
  content: string | null;
  content_type: Generated<AgentMessageContentType>;
  metadata: JSONColumnType<Record<string, unknown>> | null;
  message_timestamp: Timestamp;
  created_at: Timestamp;
}

export type AgentRunStatus =
  'processing' | 'sending' | 'completed' | 'skipped_paused' | 'failed' | 'send_unknown';
export type AgentRunBarrier = 'pre_openai' | 'pre_send';

export interface AgentRunsTable {
  id: Generated<string>;
  agent_conversation_id: string;
  source_message_id: string;
  source_agent_message_id: string | null;
  response_message_id: string | null;
  status: Generated<AgentRunStatus>;
  attempt_count: Generated<number>;
  model: string | null;
  tool_rounds: Generated<number>;
  skipped_at_barrier: AgentRunBarrier | null;
  started_at: Timestamp;
  completed_at: Timestamp | null;
  error_code: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type AgentControlAction = 'pause' | 'resume';

export interface AgentControlEventsTable {
  id: Generated<string>;
  agent_conversation_id: string;
  action: AgentControlAction;
  source: AgentControlSource;
  reason: string | null;
  provider_message_id: string | null;
  expires_at: Timestamp | null;
  metadata: JSONColumnType<Record<string, unknown>> | null;
  created_at: Timestamp;
}

export interface MenuSessionsTable {
  id: Generated<string>;
  source_message_id: string;
  token_hash: string;
  customer_phone: string;
  phone_number_id: string;
  created_at: Timestamp;
  expires_at: Timestamp;
  replaces_order_id: string | null;
}

export type MenuSendDeliveryReason =
  'explicit_request' | 'explicit_resend' | 'agent_suggestion' | 'qa_trigger';
export type MenuSendDeliveryStatus =
  'pending' | 'sent' | 'failed' | 'send_unknown' | 'blocked_recent';

export interface MenuSendDeliveriesTable {
  id: Generated<string>;
  customer_phone: string;
  source_message_id: string;
  reason: MenuSendDeliveryReason;
  status: Generated<MenuSendDeliveryStatus>;
  provider_message_id: string | null;
  error_code: string | null;
  claimed_at: Timestamp;
  completed_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AgentDatabase {
  webhook_events: WebhookEventsTable;
  agent_conversations: AgentConversationsTable;
  agent_messages: AgentMessagesTable;
  agent_runs: AgentRunsTable;
  agent_control_events: AgentControlEventsTable;
  menu_sessions: MenuSessionsTable;
  menu_send_deliveries: MenuSendDeliveriesTable;
}

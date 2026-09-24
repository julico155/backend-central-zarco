-- Up Migration
-- Agent Core conversacional (Fase 2B): conversación, historial, ejecuciones e
-- historial de control (pausa/reanudación). Aditiva, sin tocar tablas
-- existentes. Puerto directo de supabase/migrations/0014_agent_foundation.sql
-- de sarcoRestaurant, adaptado a Postgres llano (sin RLS/grants de Supabase;
-- este backend no tiene roles anon/authenticated) y sin trigger de
-- last_message_at (Backend Central mantiene updated_at/derivados desde la
-- aplicación, igual que el resto de las tablas de este repo).

create table agent_conversations (
  id                            uuid        primary key default gen_random_uuid(),

  -- Identidad durable. Solo dígitos: mismo criterio que normalizePhone().
  customer_phone                text        not null,

  -- Referencias técnicas del proveedor. Volátiles, nunca identidad.
  last_provider_conversation_id text,
  provider_phone_number_id      text,

  -- Control del agente.
  state                         text        not null default 'active',
  paused_at                     timestamptz,
  pause_expires_at              timestamptz,
  pause_reason                  text,
  pause_source                  text,
  resumed_at                    timestamptz,

  -- Denormalizaciones temporales.
  first_customer_message_at     timestamptz,
  first_ai_message_at           timestamptz,
  last_message_at               timestamptz,
  last_customer_message_at      timestamptz,
  last_ai_message_at            timestamptz,
  last_human_message_at         timestamptz,
  last_automation_message_at    timestamptz,

  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),

  constraint agent_conversations_customer_phone_unique
    unique (customer_phone),
  constraint agent_conversations_customer_phone_format
    check (customer_phone ~ '^[0-9]{8,15}$'),
  constraint agent_conversations_provider_conversation_id_not_empty
    check (last_provider_conversation_id is null
           or btrim(last_provider_conversation_id) <> ''),
  constraint agent_conversations_provider_phone_number_id_not_empty
    check (provider_phone_number_id is null
           or btrim(provider_phone_number_id) <> ''),

  constraint agent_conversations_state_check
    check (state in ('active', 'paused')),
  constraint agent_conversations_pause_source_check
    check (pause_source is null
           or pause_source in ('business_app', 'dashboard', 'api', 'system')),
  constraint agent_conversations_pause_reason_format
    check (pause_reason is null or pause_reason ~ '^[A-Za-z0-9._:-]{1,64}$'),

  constraint agent_conversations_state_coherence check (
    (
      state = 'paused'
      and paused_at    is not null
      and pause_reason is not null
      and pause_source is not null
      and resumed_at   is null
    )
    or (
      state = 'active'
      and paused_at        is null
      and pause_expires_at is null
      and pause_reason     is null
      and pause_source     is null
    )
  ),
  constraint agent_conversations_pause_expiry_after_paused
    check (pause_expires_at is null
           or (paused_at is not null and pause_expires_at > paused_at)),

  constraint agent_conversations_customer_first_last_paired
    check ((first_customer_message_at is null) = (last_customer_message_at is null)),
  constraint agent_conversations_customer_first_before_last
    check (first_customer_message_at is null
           or first_customer_message_at <= last_customer_message_at),

  constraint agent_conversations_ai_first_last_paired
    check ((first_ai_message_at is null) = (last_ai_message_at is null)),
  constraint agent_conversations_ai_first_before_last
    check (first_ai_message_at is null
           or first_ai_message_at <= last_ai_message_at)
);

create index idx_agent_conversations_last_message_at
  on agent_conversations (last_message_at desc);

create index idx_agent_conversations_paused
  on agent_conversations (paused_at desc)
  where state = 'paused';

create index idx_agent_conversations_pause_expiry
  on agent_conversations (pause_expires_at)
  where pause_expires_at is not null;

-- ============================================================================
-- agent_messages — historial completo de mensajes reales del canal
-- ============================================================================

create table agent_messages (
  id                       uuid        primary key default gen_random_uuid(),

  agent_conversation_id    uuid        not null
                             references agent_conversations (id)
                             on delete cascade,

  provider_message_id      text,
  provider_conversation_id text,

  direction                text        not null,
  role                     text        not null,
  actor                    text        not null,

  content                  text,
  content_type             text        not null default 'text',
  metadata                 jsonb,

  message_timestamp        timestamptz not null,
  created_at               timestamptz not null default now(),

  constraint agent_messages_direction_check
    check (direction in ('inbound', 'outbound')),
  constraint agent_messages_role_check
    check (role in ('user', 'assistant')),
  constraint agent_messages_actor_check
    check (actor in ('customer', 'ai', 'human', 'automation')),

  constraint agent_messages_content_type_check check (
    content_type in ('text', 'image', 'audio', 'video', 'document',
                     'sticker', 'location', 'interactive', 'unknown')
  ),

  constraint agent_messages_actor_coherence check (
    (direction = 'inbound'  and role = 'user'      and actor = 'customer')
    or
    (direction = 'outbound' and role = 'assistant' and actor in ('ai', 'human', 'automation'))
  ),

  constraint agent_messages_content_coherence check (
    (content_type =  'text' and content is not null and btrim(content) <> '')
    or
    (content_type <> 'text' and (content is null or btrim(content) <> ''))
  ),

  constraint agent_messages_provider_message_id_not_empty
    check (provider_message_id is null or btrim(provider_message_id) <> ''),
  constraint agent_messages_provider_conversation_id_not_empty
    check (provider_conversation_id is null or btrim(provider_conversation_id) <> ''),
  constraint agent_messages_metadata_is_object
    check (metadata is null or jsonb_typeof(metadata) = 'object'),
  constraint agent_messages_timestamp_range check (
    message_timestamp >= timestamptz '2000-01-01T00:00:00Z'
    and message_timestamp < timestamptz '2100-01-01T00:00:00Z'
  )
);

create unique index uq_agent_messages_provider_message_id
  on agent_messages (provider_message_id)
  where provider_message_id is not null;

create index ix_agent_messages_recent
  on agent_messages (agent_conversation_id, message_timestamp desc, id desc);

-- ============================================================================
-- agent_runs — idempotencia y estado de la EJECUCIÓN del agente
-- ============================================================================

create table agent_runs (
  id                      uuid        primary key default gen_random_uuid(),

  agent_conversation_id   uuid        not null
                            references agent_conversations (id)
                            on delete cascade,

  source_message_id       text        not null,

  source_agent_message_id uuid        references agent_messages (id)
                            on delete set null,
  response_message_id     uuid        references agent_messages (id)
                            on delete set null,

  status                  text        not null default 'processing',
  attempt_count           integer     not null default 1,
  model                   text,
  tool_rounds             integer     not null default 0,
  skipped_at_barrier      text,

  started_at              timestamptz not null default now(),
  completed_at            timestamptz,
  error_code              text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint agent_runs_source_message_id_unique unique (source_message_id),
  constraint agent_runs_source_message_id_not_empty
    check (btrim(source_message_id) <> ''),

  constraint agent_runs_status_check check (status in (
    'processing', 'sending', 'completed', 'skipped_paused', 'failed', 'send_unknown'
  )),
  constraint agent_runs_barrier_check check (
    skipped_at_barrier is null or skipped_at_barrier in ('pre_openai', 'pre_send')
  ),
  constraint agent_runs_barrier_only_when_skipped check (
    skipped_at_barrier is null or status = 'skipped_paused'
  ),
  constraint agent_runs_attempt_count_check check (attempt_count >= 1),
  constraint agent_runs_tool_rounds_check check (tool_rounds >= 0),
  constraint agent_runs_model_not_empty
    check (model is null or btrim(model) <> ''),
  constraint agent_runs_error_code_format check (
    error_code is null or error_code ~ '^[A-Za-z0-9._:-]{1,64}$'
  ),
  constraint agent_runs_completed_after_started check (
    completed_at is null or completed_at >= started_at
  ),

  constraint agent_runs_state_coherence check (
    (
      status in ('processing', 'sending')
      and completed_at        is null
      and response_message_id is null
      and error_code          is null
    )
    or (
      status = 'completed'
      and completed_at is not null
      and error_code   is null
    )
    or (
      status = 'skipped_paused'
      and completed_at        is not null
      and response_message_id is null
      and error_code          is null
      and skipped_at_barrier  is not null
    )
    or (
      status = 'failed'
      and completed_at        is not null
      and response_message_id is null
      and error_code          is not null
    )
    or (
      status = 'send_unknown'
      and completed_at is not null
      and error_code   is not null
    )
  )
);

create index ix_agent_runs_stale
  on agent_runs (started_at)
  where status in ('processing', 'sending');

create index ix_agent_runs_conversation
  on agent_runs (agent_conversation_id, created_at desc);

-- ============================================================================
-- agent_control_events — historial append-only de pausa/reanudación
-- ============================================================================

create table agent_control_events (
  id                    uuid        primary key default gen_random_uuid(),

  agent_conversation_id uuid        not null
                          references agent_conversations (id)
                          on delete cascade,

  action                text        not null,
  source                text        not null,
  reason                text,
  provider_message_id   text,
  expires_at            timestamptz,
  metadata              jsonb,

  created_at            timestamptz not null default now(),

  constraint agent_control_events_action_check
    check (action in ('pause', 'resume')),
  constraint agent_control_events_source_check
    check (source in ('business_app', 'dashboard', 'api', 'system')),
  constraint agent_control_events_reason_format
    check (reason is null or reason ~ '^[A-Za-z0-9._:-]{1,64}$'),
  constraint agent_control_events_provider_message_id_not_empty
    check (provider_message_id is null or btrim(provider_message_id) <> ''),
  constraint agent_control_events_expires_only_on_pause
    check (expires_at is null or action = 'pause'),
  constraint agent_control_events_metadata_is_object
    check (metadata is null or jsonb_typeof(metadata) = 'object')
);

create unique index uq_agent_control_events_provider_action
  on agent_control_events (agent_conversation_id, action, provider_message_id)
  where provider_message_id is not null;

create index ix_agent_control_events_conversation
  on agent_control_events (agent_conversation_id, created_at desc);

-- Down Migration
drop table if exists agent_control_events;
drop table if exists agent_runs;
drop table if exists agent_messages;
drop table if exists agent_conversations;

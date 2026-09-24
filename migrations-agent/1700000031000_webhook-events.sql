-- Up Migration
-- DB AGENTE (AGENT_DATABASE_URL). Idempotente: si `webhook_events` ya existe
-- (p. ej. la del sarcoRestaurant original) no se toca; las columnas que le
-- faltan las agrega 1700000036000_agent-schema-delta.sql.
-- Inbox durable para eventos entrantes de Kapso. No ejecuta negocio ni toca
-- tablas comerciales: solo conserva una entrega autenticada para procesarla.

create table if not exists webhook_events (
  id                uuid primary key default gen_random_uuid(),
  event_id          text not null unique,
  event_name        text not null,
  message_id        text,
  payload           jsonb not null,
  status            text not null default 'received'
    check (status in ('received', 'processing', 'processed', 'failed')),
  claim_token       uuid,
  claimed_until     timestamptz,
  attempts          integer not null default 0 check (attempts >= 0),
  max_attempts      integer not null default 5 check (max_attempts between 1 and 10),
  next_attempt_at   timestamptz,
  error_message     text,
  processed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint webhook_events_terminal_not_scheduled
    check (status in ('received', 'processing') or next_attempt_at is null),
  constraint webhook_events_terminal_not_claimed
    check (status in ('received', 'processing') or (claim_token is null and claimed_until is null))
);

-- Solo índices que NO dependen de columnas que una `webhook_events` heredada
-- todavía no tiene (claim_token/claimed_until las agrega 1700000036000, que
-- también crea el índice de leases vencidos). Mismos nombres y definiciones que
-- la DB Agente real (sarcoRestaurant 0001/0016), para no duplicarlos.
create index if not exists idx_webhook_events_message_id
  on webhook_events (message_id);

create index if not exists ix_webhook_events_claimable
  on webhook_events (next_attempt_at)
  where next_attempt_at is not null and status in ('received', 'processing');

-- Down Migration
-- Intencionalmente vacío: esta migración ADOPTA tablas que pueden existir ya
-- con datos en la DB Agente (`create ... if not exists`), así que revertirla
-- nunca borra tablas. Para descartar una DB de pruebas, bórrala entera.

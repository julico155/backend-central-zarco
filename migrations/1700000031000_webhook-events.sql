-- Up Migration
-- Inbox durable para eventos entrantes de Kapso. No ejecuta negocio ni toca
-- tablas comerciales: solo conserva una entrega autenticada para procesarla.

create table webhook_events (
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

create index idx_webhook_events_claimable
  on webhook_events (next_attempt_at, created_at)
  where status = 'received' and next_attempt_at is not null;

create index idx_webhook_events_expired_claim
  on webhook_events (claimed_until, created_at)
  where status = 'processing' and claimed_until is not null;

-- Down Migration
drop table if exists webhook_events;

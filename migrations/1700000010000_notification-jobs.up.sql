-- Avisos salientes: reemplaza order_notifications + telegram_alerts con una
-- tabla única de "trabajos de aviso", mismo patrón claim->intentar->marcar.

create table notification_jobs (
  id                   uuid primary key default gen_random_uuid(),
  kind                 text not null,  -- 'order_received' | 'confirmation' |
                                        -- 'location_request' | 'delivery_notice' |
                                        -- 'handoff_notice' | 'late_request_alert' | ...
  channel              text not null check (channel in ('whatsapp','telegram')),
  target_ref           text not null,  -- customer_id, order_id o chat_id según kind
  payload              jsonb not null,
  status               text not null default 'pending'
    check (status in ('pending','sending','sent','failed')),
  claim_token          uuid,
  claimed_until        timestamptz,
  attempts             integer not null default 0,
  next_attempt_at      timestamptz,
  external_message_id  text,
  last_error_code      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint notification_jobs_dedupe unique (kind, target_ref)
);

-- Claim de workers del job de recuperación: solo sobre lo pendiente/fallido
-- que ya puede reintentarse, nunca sobre la tabla completa.
create index idx_notification_jobs_claimable
  on notification_jobs (next_attempt_at)
  where status in ('pending', 'failed');

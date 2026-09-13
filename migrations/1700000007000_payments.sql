-- Up Migration
create table payment_attempts (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references orders(id) on delete restrict,
  customer_id    uuid references customers(id),
  opened_at      timestamptz not null default now(),
  opened_as      text not null default 'normal' check (opened_as in ('normal','late')),
  review_status  text not null default 'pending_review'
    check (review_status in ('pending_review','accepted','rejected')),
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint payment_attempts_id_order_unique unique (id, order_id)
);

-- Invariante 6 del plan: como máximo un intento "vivo" por pedido, a nivel
-- de esquema (índice único parcial), no solo en código de aplicación.
create unique index uq_payment_attempts_live
  on payment_attempts (order_id)
  where review_status in ('pending_review', 'accepted');

create table payment_proofs (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid references orders(id) on delete restrict,
  attempt_id            uuid,
  duplicate_of_id       uuid references payment_proofs(id),
  source_message_id     text not null unique,
  match_method          text not null check (match_method in (
    'current_qr_order','attached','duplicate','ambiguous','unresolved'
  )),
  routing_exception     text check (routing_exception is null or routing_exception in (
    'signal_conflict','expired_target','payment_already_accepted','closed_order'
  )),
  capture_status        text not null default 'capturing'
    check (capture_status in ('capturing','stored','failed')),
  capture_attempts      integer not null default 0,
  storage_provider      text not null default 'r2',
  storage_key           text,
  mime_type             text not null,
  byte_size             integer,
  sha256_hex            text,
  analysis_status       text not null default 'pending' check (analysis_status in ('pending','ok','failed')),
  analysis_verdict      text check (analysis_verdict is null or analysis_verdict in ('ok','suspicious','unreadable')),
  analysis_reasons      text[],
  analysis_amount_label text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- Invariante "adjudicación completa": un proof con order_id siempre tiene
  -- o una tarea (attempt_id) o un motivo explícito de por qué no la tiene.
  constraint payment_proofs_adjudication_complete check (
    order_id is null or attempt_id is not null or routing_exception is not null
  ),
  constraint payment_proofs_attempt_order_fk
    foreign key (attempt_id, order_id) references payment_attempts (id, order_id)
    match simple
);

create index idx_payment_proofs_order_id on payment_proofs (order_id);
create index idx_payment_proofs_routing_exception
  on payment_proofs (routing_exception)
  where routing_exception is not null;
create index idx_payment_proofs_unassigned
  on payment_proofs (match_method)
  where order_id is null;

-- Down Migration
drop table if exists payment_proofs;
drop table if exists payment_attempts;

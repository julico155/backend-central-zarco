-- Up Migration
-- Solicitudes que requieren aprobación humana antes de existir como pedido
-- (hoy solo por horario nocturno; el mecanismo es genérico).

create table late_order_requests (
  id                uuid primary key default gen_random_uuid(),
  request_number    text not null unique,
  customer_id       uuid references customers(id) on delete restrict,
  customer_name     text not null check (char_length(btrim(customer_name)) between 1 and 100),
  channel           text not null check (channel in ('whatsapp','web','pos')),
  delivery_type     text not null check (delivery_type in ('delivery','pickup')),
  payment_method    text not null check (payment_method in ('qr','cash','card')),
  notes             text check (notes is null or char_length(notes) <= 500),
  items_json        jsonb not null check (jsonb_typeof(items_json) = 'array'),
  promotions_json    jsonb not null default '[]'::jsonb,
  subtotal_amount   numeric(10,2) not null check (subtotal_amount > 0),
  idempotency_key   text not null unique,
  status            text not null default 'pending'
    check (status in ('pending','accepted','rejected','expired')),
  requested_at      timestamptz not null default now(),
  expires_at        timestamptz not null,
  decided_at        timestamptz,
  decided_by        text,
  order_id          uuid references orders(id) on delete restrict,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint late_order_requests_pending_is_clean check (
    status <> 'pending' or (decided_at is null and decided_by is null and order_id is null)
  ),
  constraint late_order_requests_order_only_when_accepted check (
    order_id is null or status = 'accepted'
  )
);

-- Barrido de solicitudes pendientes (worker de expiración), patrón parcial
-- sobre el estado "pendiente" en vez de la tabla completa.
create index idx_late_order_requests_pending
  on late_order_requests (expires_at)
  where status = 'pending';

-- Down Migration
drop table if exists late_order_requests;

-- Up Migration
-- Caja (turno). El local atiende de un día al otro (ej. 19 a 4) — la caja
-- ES el concepto de "día de negocio": el rango opened_at..closed_at define
-- sin ambigüedad la noche completa, sin inventar una fecha aparte. Cubre
-- efectivo y QR por igual: agrupa cualquier pedido que se confirma pagado
-- durante la sesión, no solo plata física.
create table cash_register_sessions (
  id                        uuid primary key default gen_random_uuid(),
  status                    text not null default 'open' check (status in ('open','closed')),
  opened_at                 timestamptz not null default now(),
  opened_by                 text not null,  -- username, mismo patrón que orders.status_updated_by
  opening_amount            numeric(10,2) not null check (opening_amount >= 0),
  closed_at                 timestamptz null,
  closed_by                 text null,
  counted_cash_amount       numeric(10,2) null,  -- lo que el cajero cuenta físicamente al cerrar
  expected_cash_amount      numeric(10,2) null,  -- opening_amount + ventas cash de la sesión
  cash_difference           numeric(10,2) null,  -- counted - expected
  total_cash_sales_amount   numeric(10,2) null,
  total_qr_sales_amount     numeric(10,2) null,
  total_sales_amount        numeric(10,2) null,  -- cash + qr, sin contar opening_amount
  notes                     text null
);

-- Una sola caja abierta a la vez, mismo patrón que uq_payment_attempts_live.
create unique index uq_cash_register_sessions_single_open
  on cash_register_sessions ((true)) where status = 'open';

alter table orders
  add column register_session_id uuid null references cash_register_sessions(id);

-- Down Migration
alter table orders drop column if exists register_session_id;
drop table if exists cash_register_sessions;

-- Up Migration
-- DB AGENTE (AGENT_DATABASE_URL). Idempotente: no toca tablas que ya existan.
-- Cambio respecto de la versión previa (nunca aplicada): `replaces_order_id` ya
-- no referencia `orders`, porque `orders` está en otra base de datos.
-- Menú web de WhatsApp (Fase 2C): sesión segura del enlace "Ver menú" y
-- ledger de envíos del CTA. Aditiva. Puerto de sarcoRestaurant
-- (supabase/migrations/0002_menu_sessions.sql, 0015_menu_send_deliveries.sql,
-- 0035_menu_session_replaces_order.sql), sin RLS/grants de Supabase (este
-- backend no tiene roles anon/authenticated).
--
-- menu_sessions.replaces_order_id se conserva por paridad de esquema con
-- Sarco (enlace "Cambiar mi pedido"), pero esta fase NO implementa esa
-- reapertura: SarcoMenuModule siempre crea sesiones con replaces_order_id
-- NULL. Queda lista para cuando se porte ese flujo.
--
-- Idempotencia de la creación del pedido: NO se modela aquí con una columna
-- "un pedido por sesión" (Sarco sí la tenía, `orders.menu_session_id`
-- UNIQUE). En Central se resuelve reutilizando el Idempotency-Key genérico
-- que ya usa OrdersService: el id de la sesión ES la idempotency key, así
-- que el mismo carrito reenviado reproduce la misma respuesta, y un carrito
-- DISTINTO para la misma sesión choca con `idempotency_key_reused` (409) —
-- ver menu-order.service.ts.

create table if not exists menu_sessions (
  id                 uuid primary key default gen_random_uuid(),
  source_message_id  text not null unique,
  token_hash         text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  customer_phone     text not null check (btrim(customer_phone) <> ''),
  phone_number_id    text not null check (btrim(phone_number_id) <> ''),
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null default (now() + interval '2 hours'),
  -- uuid SIN clave foránea: el pedido vive en la DB Central, no en esta.
  replaces_order_id  uuid,
  constraint menu_sessions_expires_after_created check (expires_at > created_at)
);

create index if not exists idx_menu_sessions_expires_at on menu_sessions (expires_at);
-- idx_menu_sessions_customer_phone: lo crea 1700000036000 (la DB Agente real no lo tiene).
create index if not exists ix_menu_sessions_replaces_order
  on menu_sessions (replaces_order_id)
  where replaces_order_id is not null;

-- Ledger de envíos del CTA "Ver menú". Tabla separada de menu_sessions (no
-- guarda token ni hash): protege la idempotencia técnica del ENVÍO, no la
-- sesión en sí.
create table if not exists menu_send_deliveries (
  id                   uuid primary key default gen_random_uuid(),
  customer_phone       text not null check (btrim(customer_phone) <> ''),
  source_message_id    text not null unique,
  reason               text not null
    check (reason in ('explicit_request', 'explicit_resend', 'agent_suggestion', 'qa_trigger')),
  status               text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'send_unknown', 'blocked_recent')),
  provider_message_id  text,
  error_code           text check (error_code ~ '^[A-Za-z0-9._:-]{1,64}$'),
  claimed_at           timestamptz not null default now(),
  completed_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint menu_send_deliveries_state_coherence check (
    (status = 'pending' and completed_at is null and provider_message_id is null and error_code is null)
    or (status = 'sent' and completed_at is not null and provider_message_id is not null and error_code is null)
    or (status in ('failed', 'send_unknown') and completed_at is not null and error_code is not null)
    or (status = 'blocked_recent' and completed_at is not null and provider_message_id is null and error_code is null)
  )
);

create index if not exists ix_menu_send_deliveries_recent
  on menu_send_deliveries (customer_phone, completed_at desc)
  where status = 'sent';

-- Down Migration
-- Intencionalmente vacío: esta migración ADOPTA tablas que pueden existir ya
-- con datos en la DB Agente (`create ... if not exists`), así que revertirla
-- nunca borra tablas. Para descartar una DB de pruebas, bórrala entera.

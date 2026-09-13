-- Up Migration
-- Idempotencia genérica de API (reemplaza el fingerprint atado a
-- menu_sessions del diseño anterior). Patrón estándar tipo Stripe:
-- INSERT ... ON CONFLICT sobre (api_client, endpoint, idempotency_key).
-- - Existe con mismo request_hash y completed_at no nulo -> devolver
--   response_body/response_status guardados (created:false).
-- - Existe con request_hash distinto -> 409 idempotency_key_reused.
-- - Existe con completed_at null -> hay otra ejecución en curso (bloquear
--   o reintentar), nunca proceder en paralelo con la misma key.

create table idempotency_keys (
  id               uuid primary key default gen_random_uuid(),
  api_client       text not null,
  endpoint         text not null,
  idempotency_key  text not null,
  request_hash     text not null,
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  constraint idempotency_keys_unique unique (api_client, endpoint, idempotency_key)
);

-- Down Migration
drop table if exists idempotency_keys;

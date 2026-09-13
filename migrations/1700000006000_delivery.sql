-- Up Migration
-- Tabla de bandas de tarifa: fuente única (ya no duplicada en SQL + TS).
create table delivery_tariff_bands (
  band_index          integer primary key,
  max_distance_meters integer not null check (max_distance_meters > 0),
  fee_amount          numeric(10,2) not null check (fee_amount >= 0)
);

-- Cotizaciones standalone (antes de pedido). Sin campo de "cupo": el cupo es
-- rate-limiting del canal (WhatsApp), el dominio no lo sabe.
create table delivery_quote_requests (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid references customers(id) on delete restrict,
  idempotency_key  text not null unique,
  latitude         double precision not null check (latitude between -90 and 90),
  longitude        double precision not null check (longitude between -180 and 180),
  status           text not null check (status in ('quoted','manual_quote','failed')),
  distance_meters  integer check (distance_meters is null or distance_meters >= 0),
  distance_source  text check (distance_source is null or distance_source in ('mapbox','reused')),
  fee_amount       numeric(10,2) check (fee_amount is null or fee_amount >= 0),
  error_code       text,
  created_at       timestamptz not null default now()
);

-- Down Migration
drop table if exists delivery_quote_requests;
drop table if exists delivery_tariff_bands;

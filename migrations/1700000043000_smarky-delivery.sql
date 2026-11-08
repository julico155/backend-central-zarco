-- Up Migration
-- Integración con la plataforma central de reparto (DELIVERY_PROVIDER=smarky).
-- ADITIVA: solo agrega columnas nulas y una tabla nueva; no toca datos existentes.
-- El seguimiento (mapa, GPS) vive en la plataforma; aquí solo se guarda a qué
-- entrega corresponde cada pedido y en qué estado va. Con DELIVERY_PROVIDER=internal
-- estas columnas quedan en null y no cambia nada.
alter table orders
  add column if not exists smarky_delivery_id     uuid,
  add column if not exists smarky_tracking_url    text,
  -- null | 'requesting' (reclamado, aún sin respuesta) | searching | assigned |
  -- at_restaurant | in_transit | delivered | cancelled | failed
  add column if not exists smarky_delivery_status text;

create unique index if not exists orders_smarky_delivery_id_key
  on orders (smarky_delivery_id) where smarky_delivery_id is not null;

-- Eventos de webhook ya procesados: la plataforma reintenta, así que un eventId
-- repetido se ignora.
create table if not exists smarky_webhook_events (
  event_id     uuid primary key,
  delivery_id  uuid not null,
  event_type   text not null,
  received_at  timestamptz not null default now()
);

alter table smarky_webhook_events enable row level security;
drop policy if exists backend_full_access on smarky_webhook_events;
create policy backend_full_access on smarky_webhook_events
  for all to current_user using (true) with check (true);

-- Down Migration
drop table if exists smarky_webhook_events;
drop index if exists orders_smarky_delivery_id_key;
alter table orders
  drop column if exists smarky_delivery_status,
  drop column if exists smarky_tracking_url,
  drop column if exists smarky_delivery_id;

-- Up Migration
-- Modos operativos que el admin mueve desde el POS (sin tocar código ni hacer push) y cola de pedidos.
-- ADITIVA: solo agrega columnas con default (el comportamiento actual no cambia hasta que alguien las mueva)
-- y una tabla nueva.
--
-- "Temporales" (ocasiones especiales): extended_service_enabled, manually_closed y queue_enabled. Se apagan solos una
-- vez al día, a daily_reset_hour (hora de Bolivia), para que un olvido de anoche no afecte la noche siguiente.
-- "Fijas" (no se reinician): cash_enabled, allow_promo_with_items, horario y mensajes.
alter table operational_settings
  add column if not exists cash_enabled              boolean not null default true,
  add column if not exists extended_service_enabled  boolean not null default false,
  add column if not exists manually_closed           boolean not null default false,
  add column if not exists queue_enabled             boolean not null default false,
  add column if not exists queue_capacity            integer not null default 15,
  add column if not exists queue_release_batch       integer not null default 5,
  add column if not exists allow_promo_with_items    boolean not null default true,
  add column if not exists daily_reset_hour          integer not null default 7,
  add column if not exists last_daily_reset_on       text, -- YYYY-MM-DD (Bolivia); texto a propósito: pg devuelve `date` como objeto Date
  -- Horario que ve el cliente (exacto). business_opens_hour/business_closes_hour siguen siendo el margen ancho de cordura.
  add column if not exists schedule_opens_hour       integer not null default 19,
  add column if not exists schedule_closes_hour      integer not null default 4,
  add column if not exists closed_message            text not null default 'Estamos cerrados por ahora. ¡Gracias por escribirnos!',
  add column if not exists extended_message          text not null default 'Hoy seguimos atendiendo un poco más tarde de lo normal 🙌 ¡Haz tu pedido!',
  add constraint operational_settings_queue_capacity_chk check (queue_capacity between 1 and 200),
  add constraint operational_settings_queue_batch_chk check (queue_release_batch between 1 and 50),
  add constraint operational_settings_reset_hour_chk check (daily_reset_hour between 0 and 23),
  add constraint operational_settings_schedule_opens_chk check (schedule_opens_hour between 0 and 23),
  add constraint operational_settings_schedule_closes_chk check (schedule_closes_hour between 0 and 23);

-- Hoy el efectivo está oculto en el menú de WhatsApp por una constante en el código (CASH_PAYMENT_VISIBLE = false en
-- menu-web). Para que desplegar esto NO cambie lo que ven los clientes, la fila existente arranca con efectivo apagado;
-- el admin lo enciende desde Configuración cuando quiera.
update operational_settings set cash_enabled = false where id = true;

-- Fila de espera cuando la cocina está llena y la cola está activa.
--   waiting  = se le avisó "estamos saturados", espera su turno
--   admitted = ya puede hacer su pedido (cupo reservado hasta admitted_until)
--   used     = hizo su pedido
--   expired  = no lo hizo a tiempo, o la fila se reinició
create table if not exists order_queue_entries (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid not null references customers(id),
  status           text not null default 'waiting' check (status in ('waiting', 'admitted', 'used', 'expired')),
  created_at       timestamptz not null default now(),
  notified_at      timestamptz,
  admitted_until   timestamptz,
  last_reminder_at timestamptz,
  used_at          timestamptz
);

-- Un cliente tiene como mucho UNA entrada viva a la vez.
create unique index if not exists order_queue_entries_one_live_per_customer
  on order_queue_entries (customer_id) where status in ('waiting', 'admitted');
create index if not exists order_queue_entries_status_created
  on order_queue_entries (status, created_at);

alter table order_queue_entries enable row level security;
drop policy if exists backend_full_access on order_queue_entries;
create policy backend_full_access on order_queue_entries
  for all to current_user using (true) with check (true);

-- Down Migration
drop table if exists order_queue_entries;
alter table operational_settings
  drop constraint if exists operational_settings_queue_capacity_chk,
  drop constraint if exists operational_settings_queue_batch_chk,
  drop constraint if exists operational_settings_reset_hour_chk,
  drop constraint if exists operational_settings_schedule_opens_chk,
  drop constraint if exists operational_settings_schedule_closes_chk,
  drop column if exists cash_enabled,
  drop column if exists extended_service_enabled,
  drop column if exists manually_closed,
  drop column if exists queue_enabled,
  drop column if exists queue_capacity,
  drop column if exists queue_release_batch,
  drop column if exists allow_promo_with_items,
  drop column if exists daily_reset_hour,
  drop column if exists last_daily_reset_on,
  drop column if exists schedule_opens_hour,
  drop column if exists schedule_closes_hour,
  drop column if exists closed_message,
  drop column if exists extended_message;

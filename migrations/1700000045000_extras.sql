-- Up Migration
-- Extras (carne, queso, huevo...): agregados CON precio que se suman a una línea
-- de producto. A diferencia de los complementos (solo se pueden quitar, sin
-- precio), un extra se puede pedir varias veces en una misma unidad ("doble
-- carne" = quantity 2).
--
-- Cada extra define a qué productos aplica: a todos (queso, huevo) o a una lista
-- puntual (la carne del trancapecho no es la de los mixtos y puede costar
-- distinto, así que se crea un extra por plato con su propio precio).
create table extras (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (btrim(name) <> ''),
  price          numeric(10,2) not null check (price >= 0),
  applies_to_all boolean not null default false,
  is_active      boolean not null default true,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Solo se llena cuando applies_to_all = false.
create table extra_products (
  extra_id   uuid not null references extras(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  primary key (extra_id, product_id)
);

create index idx_extra_products_product_id on extra_products (product_id);

-- RLS como el resto de las tablas públicas (ver 1700000018000 y 1700000043000): sin esto, Supabase deja la tabla
-- abierta a quien tenga la anon key. Solo el backend (current_user) accede.
alter table extras enable row level security;
drop policy if exists backend_full_access on extras;
create policy backend_full_access on extras
  for all to current_user using (true) with check (true);

alter table extra_products enable row level security;
drop policy if exists backend_full_access on extra_products;
create policy backend_full_access on extra_products
  for all to current_user using (true) with check (true);

-- Snapshot por línea: [{ extraId, name, unitPrice, quantity }]. Igual que
-- product_name_snapshot/unit_price_snapshot y excluded_complements: un pedido
-- histórico nunca debe cambiar si después el admin edita el precio o borra el
-- extra. `unit_price_snapshot` sigue siendo el precio del producto SOLO; los
-- extras se suman aparte en `subtotal` = (unit_price + Σ extras) × quantity.
alter table order_items
  add column extras jsonb not null default '[]'::jsonb;

-- Down Migration
alter table order_items drop column extras;
drop table if exists extra_products;
drop table if exists extras;

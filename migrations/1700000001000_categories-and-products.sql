-- Up Migration
-- Catálogo: categorías normalizadas (reemplazan el enum plato|bebida|extra)
-- y productos (antes menu_items).

create table categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (btrim(name) <> ''),
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table products (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  name          text not null check (btrim(name) <> ''),
  category_id   uuid not null references categories(id) on delete restrict,
  price         numeric(10,2) not null check (price >= 0),
  is_active     boolean not null default true,
  -- is_active = ¿existe en el catálogo? is_available = ¿hay stock hoy?
  -- Son ortogonales: NUNCA colapsar en un solo booleano (invariante 4 del plan).
  is_available  boolean not null default true,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index idx_products_category_id on products (category_id);

-- Down Migration
drop table if exists products;
drop table if exists categories;

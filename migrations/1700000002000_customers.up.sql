-- Cliente como entidad normal, reemplaza el string customer_phone repetido
-- en cada tabla del diseño anterior.

create table customers (
  id          uuid primary key default gen_random_uuid(),
  name        text,
  phone       text unique,
  email       text unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint customers_has_identity check (
    phone is not null or email is not null or name is not null
  )
);

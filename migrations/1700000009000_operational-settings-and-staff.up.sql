create table operational_settings (
  id                       boolean primary key default true check (id),  -- fila única
  rain_surcharge_enabled   boolean not null default false,
  rain_surcharge_amount    numeric(10,2) not null default 0,
  business_opens_hour      integer not null default 17,
  business_closes_hour     integer not null default 22,
  late_review_closes_hour  integer not null default 23,
  updated_at               timestamptz not null default now()
);

insert into operational_settings (id) values (true);

create table dashboard_users (
  id             uuid primary key default gen_random_uuid(),
  username       text not null unique,
  password_hash  text not null,
  role           text not null check (role in ('admin','kitchen','cashier')),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);

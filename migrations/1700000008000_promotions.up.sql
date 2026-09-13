create table promotions (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(btrim(name)) between 1 and 80),
  description  text check (description is null or char_length(description) <= 200),
  promo_price  numeric(10,2) not null check (promo_price > 0 and promo_price <= 5000),
  is_active    boolean not null default false,
  starts_at    timestamptz,
  ends_at      timestamptz,
  sort_order   integer not null default 0,
  image_url    text,
  archived_at  timestamptz,
  revision     integer not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint promotions_archived_not_active check (not (archived_at is not null and is_active))
);

create table promotion_items (
  id            uuid primary key default gen_random_uuid(),
  promotion_id  uuid not null references promotions(id) on delete cascade,
  product_id    uuid not null references products(id) on delete restrict,
  quantity      integer not null check (quantity between 1 and 10),
  unique (promotion_id, product_id)
);

create table order_promotions (
  id                       uuid primary key default gen_random_uuid(),
  order_id                 uuid not null references orders(id) on delete cascade,
  promotion_id             uuid references promotions(id) on delete restrict,
  promotion_name_snapshot  text not null,
  promo_price_snapshot     numeric(10,2) not null check (promo_price_snapshot > 0),
  combo_quantity           integer not null check (combo_quantity between 1 and 10),
  subtotal                 numeric(10,2) not null,
  components_snapshot      jsonb not null check (
    jsonb_typeof(components_snapshot) = 'array' and jsonb_array_length(components_snapshot) >= 2
  ),
  unique (order_id, promotion_id),
  constraint order_promotions_subtotal_matches check (
    subtotal = promo_price_snapshot * combo_quantity
  )
);

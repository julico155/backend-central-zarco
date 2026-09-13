-- Pedidos y líneas, con snapshot de nombre/precio (invariante 3: un pedido
-- histórico nunca se recalcula desde el catálogo vigente).

create sequence order_number_seq;

create table orders (
  id                          uuid primary key default gen_random_uuid(),
  order_number                text not null unique
    default ('ORD-' || lpad(nextval('order_number_seq')::text, 6, '0')),
  customer_id                 uuid references customers(id) on delete restrict,
  channel                     text not null check (channel in ('whatsapp','web','pos')),
  customer_name               text not null
    check (char_length(btrim(customer_name)) between 1 and 100),
  delivery_type               text not null check (delivery_type in ('delivery','pickup')),
  payment_method              text not null check (payment_method in ('qr','cash','card')),
  -- unpaid: no requiere nada (ej. cash en POS ya cobrado al vender).
  -- pending_review: hay un payment_attempt abierto esperando revisión humana.
  -- paid / rejected: desenlace del intento.
  payment_status              text not null default 'unpaid'
    check (payment_status in ('unpaid','pending_review','paid','rejected')),
  notes                       text check (notes is null or char_length(notes) <= 500),
  status                      text not null default 'draft' check (status in (
    'draft','awaiting_location','confirmed','preparing','ready',
    'out_for_delivery','delivered','cancelled'
  )),
  subtotal_amount             numeric(10,2) not null check (subtotal_amount >= 0),
  delivery_base_amount        numeric(10,2) not null default 0 check (delivery_base_amount >= 0),
  delivery_surcharge_amount   numeric(10,2) not null default 0 check (delivery_surcharge_amount >= 0),
  total_amount                numeric(10,2) not null check (total_amount >= 0),
  delivery_pricing            text check (delivery_pricing is null or delivery_pricing = 'dynamic'),
  delivery_quote_status       text check (delivery_quote_status is null or delivery_quote_status in (
    'pending','quoted','pending_manual','failed'
  )),
  delivery_distance_meters    integer check (delivery_distance_meters is null or delivery_distance_meters >= 0),
  delivery_latitude           double precision check (delivery_latitude between -90 and 90),
  delivery_longitude          double precision check (delivery_longitude between -180 and 180),
  delivery_fee_paid           boolean not null default false,
  cash_confirmed_at           timestamptz,
  confirmed_at                timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index idx_orders_customer_id on orders (customer_id);
create index idx_orders_status on orders (status);

create table order_items (
  id                     uuid primary key default gen_random_uuid(),
  order_id               uuid not null references orders(id) on delete cascade,
  product_id             uuid not null references products(id) on delete restrict,
  -- Snapshot: el pedido histórico NUNCA se recalcula desde el catálogo vigente.
  product_code_snapshot  text not null,
  product_name_snapshot  text not null,
  unit_price_snapshot    numeric(10,2) not null check (unit_price_snapshot >= 0),
  quantity               integer not null check (quantity between 1 and 10),
  subtotal               numeric(10,2) not null check (subtotal >= 0),
  created_at             timestamptz not null default now()
);

create index idx_order_items_order_id on order_items (order_id);

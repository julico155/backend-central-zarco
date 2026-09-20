-- Up Migration
-- Complementos (tomate, lechuga, cebolla, quirquiña, etc.): lista por
-- producto, sin precio propio — solo sirven para excluir ("sin quirquiña").
-- Por defecto todos van incluidos; el pedido guarda un snapshot de nombres
-- excluidos por línea (no un id de complemento) porque, igual que
-- product_name_snapshot/unit_price_snapshot, un pedido histórico nunca debe
-- cambiar si después el admin edita o borra el complemento en el catálogo.
create table product_complements (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete cascade,
  name        text not null check (btrim(name) <> ''),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  constraint uq_product_complements_product_name unique (product_id, name)
);

create index idx_product_complements_product_id on product_complements (product_id);

-- Dos líneas del mismo producto con distinta selección de complementos NO
-- se pueden fusionar en una sola fila con más quantity (perderían cuál
-- unidad va "sin quirquiña"), así que cada línea guarda su propia exclusión.
alter table order_items
  add column excluded_complements text[] not null default '{}';

-- Down Migration
alter table order_items drop column excluded_complements;
drop table if exists product_complements;

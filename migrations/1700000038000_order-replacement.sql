-- Up Migration
-- FASE 3: "modificar mi pedido" (replace-not-mutate). Nunca se editan las
-- líneas de un pedido existente: uno nuevo reemplaza al viejo, vinculados acá.
alter table orders
  add column replaces_order_id    uuid references orders (id),
  add column replaced_by_order_id uuid references orders (id);

-- Un pedido viejo solo puede ser reemplazado UNA vez — barrera extra además
-- del `select ... for update` que ya toma el replacement en la misma fila.
create unique index uq_orders_replaced_by_order_id
  on orders (replaced_by_order_id) where replaced_by_order_id is not null;

-- "Último pedido activo de un cliente": ya existían idx_orders_customer_id e
-- idx_orders_status por separado, pero no un compuesto para
-- `where customer_id = ? and status not in ('cancelled','delivered')
--  order by created_at desc limit 1`.
create index idx_orders_customer_active on orders (customer_id, created_at desc)
  where status not in ('cancelled', 'delivered');

-- Down Migration
drop index if exists idx_orders_customer_active;
drop index if exists uq_orders_replaced_by_order_id;
alter table orders
  drop column if exists replaced_by_order_id,
  drop column if exists replaces_order_id;

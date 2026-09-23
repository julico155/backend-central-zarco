-- Up Migration
-- Repartidores: nuevo rol `delivery` y asignación de pedidos de delivery.
alter table dashboard_users drop constraint if exists dashboard_users_role_check;
alter table dashboard_users add constraint dashboard_users_role_check
  check (role in ('admin','kitchen','cashier','delivery'));

alter table orders
  add column delivery_driver_id    uuid references dashboard_users (id),
  add column delivery_driver_name  text,
  add column delivery_accepted_at  timestamptz,
  add column delivered_at          timestamptz;

create index idx_orders_delivery_driver_id on orders (delivery_driver_id) where delivery_driver_id is not null;

-- Down Migration
drop index if exists idx_orders_delivery_driver_id;
alter table orders
  drop column if exists delivered_at,
  drop column if exists delivery_accepted_at,
  drop column if exists delivery_driver_name,
  drop column if exists delivery_driver_id;

alter table dashboard_users drop constraint if exists dashboard_users_role_check;
alter table dashboard_users add constraint dashboard_users_role_check
  check (role in ('admin','kitchen','cashier'));

-- Up Migration
-- Nuevo tipo de pedido `dine_in` (para comer en el local, mesa). `pickup`
-- sigue siendo "para llevar desde el mostrador" y `delivery` a domicilio.
alter table orders drop constraint if exists orders_delivery_type_check;
alter table orders add constraint orders_delivery_type_check
  check (delivery_type in ('delivery','pickup','dine_in'));

alter table late_order_requests drop constraint if exists late_order_requests_delivery_type_check;
alter table late_order_requests add constraint late_order_requests_delivery_type_check
  check (delivery_type in ('delivery','pickup','dine_in'));

-- Down Migration
alter table late_order_requests drop constraint if exists late_order_requests_delivery_type_check;
alter table late_order_requests add constraint late_order_requests_delivery_type_check
  check (delivery_type in ('delivery','pickup'));

alter table orders drop constraint if exists orders_delivery_type_check;
alter table orders add constraint orders_delivery_type_check
  check (delivery_type in ('delivery','pickup'));

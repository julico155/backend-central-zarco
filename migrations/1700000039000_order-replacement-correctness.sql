-- Up Migration
-- Correctivo de 1700000038000: esa migración ya pudo estar aplicada en un
-- entorno desplegado, así que esta NO la toca — solo agrega lo que faltaba.
--
-- "Un pedido viejo solo puede tener un replacement" es una restricción
-- sobre replaces_order_id (la columna del pedido NUEVO que apunta al
-- viejo) — la unique de 038 vive en replaced_by_order_id (la columna del
-- pedido VIEJO), que en cambio garantiza "un pedido nuevo no es el
-- replacement de más de un viejo". Mantenemos ambas: juntas hacen la
-- relación estrictamente 1:1 en los dos sentidos.
create unique index if not exists uq_orders_replaces_order_id
  on orders (replaces_order_id) where replaces_order_id is not null;

-- Down Migration
drop index if exists uq_orders_replaces_order_id;

-- Up Migration
-- La reportería filtra y agrupa pedidos por rango de fechas (created_at) y
-- por turno de caja; sin estos índices cada reporte recorre toda la tabla.
create index if not exists idx_orders_created_at on orders (created_at);
create index if not exists idx_orders_register_session_id on orders (register_session_id);

-- Down Migration
drop index if exists idx_orders_register_session_id;
drop index if exists idx_orders_created_at;

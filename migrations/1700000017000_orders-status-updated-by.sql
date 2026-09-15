-- Up Migration

-- El tablero de cocina ahora exige login (JWT, rol kitchen/admin) para
-- cambiar de estado un pedido — se guarda qué staff lo hizo.
alter table orders
  add column status_updated_by text;

-- Down Migration
alter table orders drop column if exists status_updated_by;

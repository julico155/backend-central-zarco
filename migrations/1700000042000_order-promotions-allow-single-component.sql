-- Up Migration
-- El check original (components_snapshot con >= 2 elementos) asumía que toda
-- promoción es un combo de productos distintos. Hay promos reales de un solo
-- producto (ej. "2x Salchiburguer"), donde promotion_items tiene una sola
-- fila con quantity=2 y por lo tanto components_snapshot trae un solo
-- elemento: el checkout de esas promos daba 500 (constraint violation) en
-- vez de crear el pedido, tanto por WhatsApp como por POS.
alter table order_promotions drop constraint order_promotions_components_snapshot_check;
alter table order_promotions add constraint order_promotions_components_snapshot_check check (
  jsonb_typeof(components_snapshot) = 'array' and jsonb_array_length(components_snapshot) >= 1
);

-- Down Migration
alter table order_promotions drop constraint order_promotions_components_snapshot_check;
alter table order_promotions add constraint order_promotions_components_snapshot_check check (
  jsonb_typeof(components_snapshot) = 'array' and jsonb_array_length(components_snapshot) >= 2
);

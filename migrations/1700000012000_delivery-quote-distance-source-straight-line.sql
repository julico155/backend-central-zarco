-- Up Migration

-- Sin Mapbox conectado todavía, la distancia se mide en línea recta
-- (haversine) como MVP — 'straight_line' lo deja explícito en el dato en vez
-- de mentir con 'mapbox'. Swap a distancia real por calle es un cambio de
-- DistanceService, no de esquema.
alter table delivery_quote_requests
  drop constraint if exists delivery_quote_requests_distance_source_check;

alter table delivery_quote_requests
  add constraint delivery_quote_requests_distance_source_check
  check (distance_source is null or distance_source in ('mapbox', 'straight_line', 'reused'));

-- Down Migration
alter table delivery_quote_requests
  drop constraint if exists delivery_quote_requests_distance_source_check;

alter table delivery_quote_requests
  add constraint delivery_quote_requests_distance_source_check
  check (distance_source is null or distance_source in ('mapbox', 'reused'));

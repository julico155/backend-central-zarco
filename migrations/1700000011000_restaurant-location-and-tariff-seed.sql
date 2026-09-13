-- Up Migration

-- Coordenadas del restaurante: origen para medir distancia de delivery.
-- Separado de la tarifa a propósito (config operativa, no regla de negocio).
alter table operational_settings
  add column restaurant_latitude  double precision,
  add column restaurant_longitude double precision;

-- Bandas de tarifa reales, portadas de delivery-tariff-v2 (saas_smarky,
-- migración 0025_delivery_tariff_v2_and_manual_quote.sql). Banda k cubre
-- ((k-1)*1000, k*1000] metros. Fuente única: esta tabla, no duplicada en
-- código — a diferencia del proyecto viejo, que la mantenía sincronizada a
-- mano en SQL y TypeScript.
insert into delivery_tariff_bands (band_index, max_distance_meters, fee_amount) values
  (1,   1000, 10),
  (2,   2000, 12),
  (3,   3000, 14),
  (4,   4000, 16),
  (5,   5000, 18),
  (6,   6000, 20),
  (7,   7000, 23),
  (8,   8000, 26),
  (9,   9000, 28),
  (10, 10000, 30),
  (11, 11000, 33),
  (12, 12000, 36),
  (13, 13000, 39),
  (14, 14000, 42),
  (15, 15000, 45),
  (16, 16000, 48);

-- Down Migration
delete from delivery_tariff_bands where band_index between 1 and 16;
alter table operational_settings
  drop column if exists restaurant_latitude,
  drop column if exists restaurant_longitude;

-- Up Migration

-- Tarifa de delivery actualizada (reemplaza por completo la tabla de
-- 1700000011000_restaurant-location-and-tariff-seed.sql). Banda k cubre
-- ((k-1 banda).max_distance_meters, esta banda.max_distance_meters] metros.
-- Techo automático ahora 18 km (antes 16 km); fuera de eso, pending_manual.
delete from delivery_tariff_bands;

insert into delivery_tariff_bands (band_index, max_distance_meters, fee_amount) values
  (1,   2000, 10),
  (2,   3000, 12),
  (3,   4000, 13),
  (4,   5000, 15),
  (5,   6000, 17),
  (6,   7000, 19),
  (7,   8000, 21),
  (8,   9000, 25),
  (9,  11000, 27),
  (10, 12000, 30),
  (11, 13000, 32),
  (12, 14000, 34),
  (13, 15000, 36),
  (14, 16000, 40),
  (15, 17000, 42),
  (16, 18000, 44);

-- Down Migration

delete from delivery_tariff_bands;

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

-- Up Migration
-- El horario real no es fijo (varía ±1h noche a noche), así que deja de ser
-- el límite preciso de apertura/cierre — pasa a ser solo un margen ancho de
-- cordura (ej. "cerrado de 6am a 4pm", para descartar un mensaje a las 10am).
-- Adentro de ese margen, la caja (cash_register_sessions) es la que decide
-- de verdad si se toma el pedido directo o se encola para revisión humana —
-- ver checkoutGateAt en common/time/service-window.ts. Ya no hace falta una
-- tercera hora intermedia: business_closes_hour (el viejo límite
-- open→late_review) se descarta, y late_review_closes_hour (el viejo límite
-- final) pasa a ser el nuevo business_closes_hour.
alter table operational_settings
  drop column business_closes_hour;

alter table operational_settings
  rename column late_review_closes_hour to business_closes_hour;

-- Down Migration
alter table operational_settings
  rename column business_closes_hour to late_review_closes_hour;

alter table operational_settings
  add column business_closes_hour integer not null default 22;

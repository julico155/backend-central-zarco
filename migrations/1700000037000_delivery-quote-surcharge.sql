-- Up Migration
-- La cotización sin pedido (POST /delivery/quotes) ahora incluye el recargo por
-- lluvia vigente al momento de cotizar: se guarda para que una respuesta
-- repetida (misma Idempotency-Key) devuelva el mismo monto aunque el recargo
-- cambie después. Filas anteriores quedan en null (= sin recargo).
alter table delivery_quote_requests
  add column surcharge_amount numeric(10,2)
    check (surcharge_amount is null or surcharge_amount >= 0);

-- Down Migration
alter table delivery_quote_requests drop column if exists surcharge_amount;

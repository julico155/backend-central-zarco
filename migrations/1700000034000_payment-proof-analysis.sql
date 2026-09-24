-- Up Migration
-- Fase 2D: análisis visual de comprobantes. Aditiva sobre `payment_proofs`
-- (ya migrada en 1700000007000_payments.sql y siguientes). Los hechos
-- estructurados que produce la lectura (banco, cuenta, titular, monto,
-- referencia, fecha) se guardan en un solo JSONB (`analysis_facts`) en vez
-- de una columna por campo: es lo mismo que sarcoRestaurant persiste
-- (analysis_amount/reference/model/destination_*), reempaquetado para no
-- ensanchar la tabla con columnas mayormente NULL. `analysis_status`,
-- `analysis_verdict`, `analysis_reasons` y `analysis_amount_label` YA
-- existen (1700000007000) y no se tocan.

alter table payment_proofs
  add column analysis_facts jsonb,
  add column analyzed_at timestamptz,
  add column analysis_model text;

alter table payment_proofs
  add constraint payment_proofs_analysis_facts_is_object
    check (analysis_facts is null or jsonb_typeof(analysis_facts) = 'object');

-- Coherencia igual a la de sarcoRestaurant (0025_payment_proof_analysis.sql):
-- 'ok' exige veredicto + instante de análisis; 'pending'/'failed' nunca los
-- llevan (una fila 'failed' significa "no se pudo leer", no "se leyó y no
-- cuadra" — por eso tampoco tiene analysis_facts).
alter table payment_proofs
  add constraint payment_proofs_analysis_coherence check (
    (analysis_status = 'ok' and analysis_verdict is not null and analyzed_at is not null)
    or (analysis_status in ('pending', 'failed') and analysis_verdict is null and analyzed_at is null)
  );

-- Búsqueda de "este número de transacción ya se usó" (referenceReused).
create index idx_payment_proofs_analysis_reference
  on payment_proofs (((analysis_facts ->> 'transactionRef')))
  where analysis_facts ->> 'transactionRef' is not null;

-- Down Migration
drop index if exists idx_payment_proofs_analysis_reference;
alter table payment_proofs drop constraint if exists payment_proofs_analysis_coherence;
alter table payment_proofs drop constraint if exists payment_proofs_analysis_facts_is_object;
alter table payment_proofs drop column if exists analysis_model;
alter table payment_proofs drop column if exists analyzed_at;
alter table payment_proofs drop column if exists analysis_facts;

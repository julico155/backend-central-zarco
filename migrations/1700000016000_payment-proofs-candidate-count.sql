-- Up Migration

-- Cuántos pedidos QR candidatos vio resolveAssociation al decidir (0, 1 o
-- N). Antes se calculaba y se descartaba — persistirlo permite auditar
-- después por qué un comprobante quedó 'ambiguous' o 'unresolved' sin tener
-- que reconstruir la ventana de tiempo a mano.
alter table payment_proofs
  add column candidate_count integer;

-- Down Migration
alter table payment_proofs drop column if exists candidate_count;

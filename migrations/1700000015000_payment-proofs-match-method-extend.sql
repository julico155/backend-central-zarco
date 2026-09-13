-- Up Migration

-- Dominio completo de match_method portado de saas_smarky
-- (0021_payment_proof_routing_methods.sql): agrega los niveles 0/1/2 del
-- algoritmo de asociación (reply_to_qr, single_open_qr_order) y 'manual'
-- (asignación humana vía POST /payment-proofs/:id/assign).
alter table payment_proofs
  drop constraint if exists payment_proofs_match_method_check;

alter table payment_proofs
  add constraint payment_proofs_match_method_check
  check (match_method in (
    'reply_to_qr', 'single_open_qr_order', 'current_qr_order',
    'attached', 'duplicate', 'ambiguous', 'manual', 'unresolved'
  ));

-- Down Migration
alter table payment_proofs
  drop constraint if exists payment_proofs_match_method_check;

alter table payment_proofs
  add constraint payment_proofs_match_method_check
  check (match_method in (
    'current_qr_order', 'attached', 'duplicate', 'ambiguous', 'unresolved'
  ));

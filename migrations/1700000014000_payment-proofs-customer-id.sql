-- Up Migration

-- resolveAssociation (portado de saas_smarky) necesita identidad de cliente
-- independiente de order_id (un proof sin pedido asociado todavía sigue
-- necesitando saber de qué cliente es, para el lock por cliente y para
-- detectar duplicados por sha256 antes de que exista adjudicación).
alter table payment_proofs
  add column customer_id uuid references customers(id);

create index idx_payment_proofs_customer_sha
  on payment_proofs (customer_id, sha256_hex)
  where sha256_hex is not null;

create index idx_payment_proofs_customer_routing_exception
  on payment_proofs (customer_id, routing_exception, created_at)
  where routing_exception is not null;

-- Down Migration
drop index if exists idx_payment_proofs_customer_routing_exception;
drop index if exists idx_payment_proofs_customer_sha;
alter table payment_proofs drop column if exists customer_id;

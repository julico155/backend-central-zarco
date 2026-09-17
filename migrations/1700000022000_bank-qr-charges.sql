-- Up Migration
-- QR real del banco (Banco Económico) vinculado 1 a 1 con el payment_attempt
-- que ya usa todo el resto del sistema (decide(), vínculo a caja, CAS). No
-- reemplaza payment_attempts, lo complementa: acá vive el detalle bancario
-- (qrId, imagen, estado del lado del banco) que payment_attempts no necesita
-- conocer.
create table bank_qr_charges (
  id                     uuid primary key default gen_random_uuid(),
  order_id               uuid not null references orders(id) on delete restrict,
  payment_attempt_id     uuid not null,
  qr_id                  text not null unique,
  transaction_id         text not null,
  amount                 numeric(10,2) not null,
  due_date               date not null,
  status                 text not null default 'pending'
    check (status in ('pending','confirmed','cancelled','expired')),
  qr_image_base64        text not null,
  raw_generate_response  jsonb,
  raw_status_response    jsonb,
  raw_notify_payload     jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint bank_qr_charges_attempt_order_fk
    foreign key (payment_attempt_id, order_id)
    references payment_attempts (id, order_id)
);

create index idx_bank_qr_charges_order_id on bank_qr_charges (order_id);
create index idx_bank_qr_charges_pending on bank_qr_charges (status) where status = 'pending';

-- Down Migration
drop table if exists bank_qr_charges;

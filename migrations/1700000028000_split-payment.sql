-- Up Migration
-- Pago dividido (POS presencial): parte efectivo, parte QR, cada monto
-- confirmado por su propio camino existente (cash/confirm y
-- payment-attempts.decide/confirmPresencial) — sin tabla nueva, solo estos
-- tres campos en el pedido. payment_status pasa a 'paid' recién cuando LAS
-- DOS partes están confirmadas (ver OrdersService/PaymentAttemptsService).
alter table orders drop constraint if exists orders_payment_method_check;
alter table orders add constraint orders_payment_method_check
  check (payment_method in ('qr','cash','card','split'));

alter table orders add column split_cash_amount numeric(10,2) null check (split_cash_amount >= 0);
alter table orders add column split_qr_amount numeric(10,2) null check (split_qr_amount >= 0);
alter table orders add column split_cash_confirmed_at timestamptz null;

-- Down Migration
alter table orders drop column if exists split_cash_confirmed_at;
alter table orders drop column if exists split_qr_amount;
alter table orders drop column if exists split_cash_amount;
alter table orders drop constraint if exists orders_payment_method_check;
alter table orders add constraint orders_payment_method_check
  check (payment_method in ('qr','cash','card'));

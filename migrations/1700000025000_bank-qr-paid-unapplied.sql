-- Up Migration
-- Pago que el banco confirma pero que no se puede aplicar a su pedido
-- (típicamente: entró después de cerrar la caja de la jornada). La plata YA
-- está en la cuenta, así que no se puede descartar ni aplicar a destiempo —
-- aplicarla al abrir la caja del día siguiente la metería en el cuadre de
-- otra jornada, y el pedido de anoche ya no se va a cocinar. Queda en
-- 'paid_unapplied' para que un humano decida: aplicarlo (si el local sigue
-- abierto) o devolverle la plata al cliente y marcar 'refunded'. El banco no
-- expone ninguna API de devolución (ver manual v1.0.0), así que devolver es
-- siempre manual y esto es solo el registro de que hay que hacerlo.
alter table bank_qr_charges drop constraint if exists bank_qr_charges_status_check;
alter table bank_qr_charges add constraint bank_qr_charges_status_check
  check (status in ('pending','confirmed','cancelled','expired','paid_unapplied','refunded'));

-- Primer instante en que el banco lo reportó pagado sin poder aplicarlo.
-- Da el margen de gracia: mientras esté dentro, el cron sigue reintentando
-- (cubre el cierre de caja de dos minutos por cambio de turno); pasado el
-- margen, escala a 'paid_unapplied' y avisa al staff.
alter table bank_qr_charges add column paid_detected_at timestamptz null;

-- Notas de la resolución manual (quién devolvió, por qué, referencia).
alter table bank_qr_charges add column resolution_notes text null;

create index idx_bank_qr_charges_paid_unapplied on bank_qr_charges (status)
  where status = 'paid_unapplied';

-- Down Migration
drop index if exists idx_bank_qr_charges_paid_unapplied;
alter table bank_qr_charges drop column if exists resolution_notes;
alter table bank_qr_charges drop column if exists paid_detected_at;
alter table bank_qr_charges drop constraint if exists bank_qr_charges_status_check;
alter table bank_qr_charges add constraint bank_qr_charges_status_check
  check (status in ('pending','confirmed','cancelled','expired'));

-- Up Migration
-- order_number pasa a ser solo el número que se le dice/imprime al
-- cliente ("Pedido #5"), y reinicia cada vez que se ABRE la caja — no cada
-- día calendario, porque el turno cruza medianoche (el mismo motivo por el
-- que ya usamos la caja como "día de negocio" en otros lados). Por eso deja
-- de ser único a nivel de base.
--
-- bank_reference toma el rol que tenía order_number de identificador único
-- para siempre: es lo que se manda al banco como transactionId en cada QR
-- real (ver QrPaymentsService.generateForOrder) — si dos pedidos de turnos
-- distintos comparten order_number ("Pedido #1" de hoy y de mañana), NUNCA
-- van a compartir bank_reference, así que el banco jamás ve un
-- transactionId repetido.
alter table orders drop constraint if exists orders_order_number_key;
alter table orders alter column order_number drop default;

alter table orders add column bank_reference text;
update orders set bank_reference = 'REF-' || lpad(nextval('order_number_seq')::text, 6, '0')
  where bank_reference is null;
alter table orders alter column bank_reference
  set default ('REF-' || lpad(nextval('order_number_seq')::text, 6, '0'));
alter table orders alter column bank_reference set not null;
alter table orders add constraint orders_bank_reference_key unique (bank_reference);

-- Qué apertura de caja ancla la numeración de este pedido — null en los
-- pedidos viejos, de antes de este cambio, y en el caso borde de un pedido
-- creado antes de que exista siquiera una primera sesión de caja.
alter table orders add column numbering_session_id uuid null references cash_register_sessions(id);

-- Contador que cada pedido nuevo incrementa atómicamente
-- (UPDATE ... SET next_order_number = next_order_number + 1 RETURNING ...);
-- arranca en 0 en cada sesión nueva, así el primer pedido del turno es el 1.
alter table cash_register_sessions add column next_order_number integer not null default 0;

-- Down Migration
alter table cash_register_sessions drop column if exists next_order_number;
alter table orders drop column if exists numbering_session_id;
alter table orders drop constraint if exists orders_bank_reference_key;
alter table orders drop column if exists bank_reference;
alter table orders alter column order_number
  set default ('ORD-' || lpad(nextval('order_number_seq')::text, 6, '0'));
alter table orders add constraint orders_order_number_key unique (order_number);

-- Up Migration
-- Fase 2E: `delivery_fee_paid` pasa a ser TRIESTADO, igual que en
-- sarcoRestaurant (0033_delivery_fee_paid_override.sql):
--   NULL  = nadie se pronunció todavía (manda la deducción del pedido/comprobante)
--   true  = una persona marcó "envío pagado"
--   false = una persona marcó "hay que cobrar el envío" (NO es lo mismo que NULL)
-- Antes era `boolean not null default false`, que no podía distinguir "nadie
-- decidió" de "alguien decidió cobrar". Nadie escribía esta columna todavía,
-- así que TODAS las filas existentes son "sin override" y pasan a NULL.

alter table orders alter column delivery_fee_paid drop not null;
alter table orders alter column delivery_fee_paid drop default;
update orders set delivery_fee_paid = null where delivery_fee_paid = false;

alter table orders add column delivery_fee_paid_at timestamptz;

alter table orders
  add constraint orders_delivery_fee_paid_coherence check (
    (delivery_fee_paid is null and delivery_fee_paid_at is null)
    or (delivery_fee_paid is not null and delivery_fee_paid_at is not null)
  );

-- Down Migration
alter table orders drop constraint if exists orders_delivery_fee_paid_coherence;
alter table orders drop column if exists delivery_fee_paid_at;
update orders set delivery_fee_paid = false where delivery_fee_paid is null;
alter table orders alter column delivery_fee_paid set default false;
alter table orders alter column delivery_fee_paid set not null;

-- Up Migration
alter table orders
  add column dropoff_address text;

alter table orders
  add constraint orders_dropoff_address_not_blank
  check (
    dropoff_address is null
    or char_length(btrim(dropoff_address)) > 0
  );

-- Down Migration
alter table orders
  drop constraint if exists orders_dropoff_address_not_blank;

alter table orders
  drop column if exists dropoff_address;

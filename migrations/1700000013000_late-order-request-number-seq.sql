-- Up Migration
create sequence late_order_request_number_seq;

alter table late_order_requests
  alter column request_number
  set default ('SOL-' || lpad(nextval('late_order_request_number_seq')::text, 6, '0'));

-- Down Migration
alter table late_order_requests
  alter column request_number drop default;

drop sequence if exists late_order_request_number_seq;

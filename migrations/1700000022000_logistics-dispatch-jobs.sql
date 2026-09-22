-- Up Migration
create table logistics_dispatch_jobs (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references orders(id) on delete restrict,
  source_system         text not null check (char_length(btrim(source_system)) > 0),
  external_order_id     text not null check (char_length(btrim(external_order_id)) > 0),
  payload               jsonb not null check (jsonb_typeof(payload) = 'object'),
  status                text not null default 'pending'
    check (status in ('pending', 'sending', 'succeeded', 'failed')),
  attempts              integer not null default 0 check (attempts >= 0),
  next_attempt_at       timestamptz not null default now(),
  claim_token           uuid,
  claimed_until         timestamptz,
  logistics_delivery_id uuid,
  remote_status_code    integer,
  last_error_code       text,
  completed_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint logistics_dispatch_jobs_one_per_order unique (order_id),
  constraint logistics_dispatch_jobs_source_external_unique unique (source_system, external_order_id),
  constraint logistics_dispatch_jobs_success_has_delivery_id check (
    status <> 'succeeded'
    or (logistics_delivery_id is not null and completed_at is not null)
  )
);

create index logistics_dispatch_jobs_claimable_idx
  on logistics_dispatch_jobs (next_attempt_at, created_at)
  where status = 'pending';

create index logistics_dispatch_jobs_sending_lease_idx
  on logistics_dispatch_jobs (claimed_until)
  where status = 'sending';

-- Down Migration
drop table if exists logistics_dispatch_jobs;

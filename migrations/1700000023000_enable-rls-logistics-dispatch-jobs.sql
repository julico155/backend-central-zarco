-- Up Migration
alter table public.logistics_dispatch_jobs enable row level security;

create policy backend_full_access
on public.logistics_dispatch_jobs
for all
to current_user
using (true)
with check (true);

-- Up Migration
--
-- Ninguna tabla tenía RLS activado: Supabase las marca como expuestas sin
-- protección vía su API REST (PostgREST) para cualquiera con la anon key.
-- Este backend nunca pasa por PostgREST (se conecta directo con pg/Kysely
-- vía DATABASE_URL), así que la política de acceso total va dirigida a
-- CURRENT_USER: como esta migración corre con las mismas credenciales que
-- usa la app (DATABASE_URL), el rol autorizado queda fijado automáticamente
-- al rol real del backend, sea cual sea su nombre. Todo lo demás (anon,
-- authenticated, o cualquier otro rol) queda bloqueado por RLS.
do $$
declare
  tbl text;
begin
  for tbl in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format(
      'create policy backend_full_access on public.%I for all to current_user using (true) with check (true)',
      tbl
    );
  end loop;
end $$;

-- Down Migration
do $$
declare
  tbl text;
begin
  for tbl in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('drop policy if exists backend_full_access on public.%I', tbl);
    execute format('alter table public.%I disable row level security', tbl);
  end loop;
end $$;

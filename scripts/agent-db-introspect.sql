-- SOLO LECTURA. Ejecutar en la DB Agente (SQL editor de Supabase o psql) para
-- comparar su esquema real con lo que espera Backend Central. No modifica nada.

-- 1) Columnas
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('webhook_events','agent_conversations','agent_messages','agent_runs',
                     'agent_control_events','menu_sessions','menu_send_deliveries')
order by table_name, ordinal_position;

-- 2) Constraints (PK, UNIQUE, FK, CHECK)
select c.conrelid::regclass as tabla, c.conname, c.contype, pg_get_constraintdef(c.oid) as definicion
from pg_constraint c
where c.conrelid::regclass::text in ('webhook_events','agent_conversations','agent_messages','agent_runs',
                                     'agent_control_events','menu_sessions','menu_send_deliveries')
order by 1, 3, 2;

-- 3) Índices
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in ('webhook_events','agent_conversations','agent_messages','agent_runs',
                    'agent_control_events','menu_sessions','menu_send_deliveries')
order by 1, 2;

-- 4) Triggers
select event_object_table as tabla, trigger_name, action_timing, event_manipulation, action_statement
from information_schema.triggers
where event_object_schema = 'public'
  and event_object_table in ('webhook_events','agent_conversations','agent_messages','agent_runs',
                             'agent_control_events','menu_sessions','menu_send_deliveries')
order by 1, 2;

-- 5) Filas heredadas que el DELTA de webhook_events va a tocar
select status, count(*) as filas
from webhook_events
group by status
order by status;

-- Up Migration
-- DELTA de la DB Agente. Todo lo que la DB real (forma de sarcoRestaurant)
-- NO tiene y Backend Central necesita. Aditiva e idempotente: en una DB nueva
-- (creada por 031-033) también es segura. Nunca borra ni reescribe datos.
--
-- 1) webhook_events.claim_token / claimed_until: el inbox durable de Central.
--    Sarco guardaba el lease de una fila `processing` en `next_attempt_at`.

alter table webhook_events
  add column if not exists claim_token uuid,
  add column if not exists claimed_until timestamptz;

-- Filas `processing` heredadas: su lease estaba en next_attempt_at. Se copia
-- para que Central pueda recuperarlas cuando venza (si no, quedarían en
-- `processing` para siempre). Con la tabla vacía no toca nada.
update webhook_events
   set claimed_until = next_attempt_at
 where status = 'processing'
   and claimed_until is null
   and next_attempt_at is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'webhook_events_terminal_not_claimed'
       and conrelid = 'webhook_events'::regclass
  ) then
    alter table webhook_events
      add constraint webhook_events_terminal_not_claimed
      check (status in ('received', 'processing') or (claim_token is null and claimed_until is null));
  end if;
end $$;

-- Recuperación de leases vencidos (WebhookInboxService.claimNextRecoverable).
-- El índice de filas `received` ya existe como ix_webhook_events_claimable
-- (mismo criterio que el de Sarco): no se duplica.
create index if not exists idx_webhook_events_expired_claim
  on webhook_events (claimed_until, created_at)
  where status = 'processing' and claimed_until is not null;

-- 2) agent_messages: el código deduplica wamids por violación de UNIQUE
--    (AgentRepository.insertMessage → 'duplicate'); la DB real no tiene este
--    índice. Antes de crearlo se comprueba que no haya duplicados y, si los
--    hay, se aborta SIN tocar nada (esta migración corre en una transacción).
do $$
declare
  dupes bigint;
begin
  if to_regclass('uq_agent_messages_provider_message_id') is null then
    select count(*) into dupes
      from (
        select 1
          from agent_messages
         where provider_message_id is not null
         group by provider_message_id
        having count(*) > 1
      ) d;
    if dupes > 0 then
      raise exception 'agent_messages tiene % provider_message_id duplicados: resolverlos antes de crear uq_agent_messages_provider_message_id', dupes;
    end if;
    create unique index uq_agent_messages_provider_message_id
      on agent_messages (provider_message_id)
      where provider_message_id is not null;
  end if;
end $$;

create index if not exists ix_agent_messages_recent
  on agent_messages (agent_conversation_id, message_timestamp desc, id desc);

-- 3) menu_sessions: MenuSessionRepository.findValidByPhone filtra por teléfono.
create index if not exists idx_menu_sessions_customer_phone
  on menu_sessions (customer_phone);

-- Down Migration
-- Intencionalmente vacío: en una DB nueva estos objetos pertenecen al esquema
-- vigente, y borrarlos destruiría el lease de eventos en vuelo y la
-- deduplicación de mensajes.

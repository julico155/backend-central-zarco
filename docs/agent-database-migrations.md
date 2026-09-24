# Migraciones de la DB Agente

Pipeline separado del de negocio:

| | DB | Variable | Carpeta | Scripts |
|---|---|---|---|---|
| Central | negocio | `DATABASE_URL` | `migrations/` | `npm run migrate:central:up` / `:down` / `:plan` |
| Agente | WhatsApp / agente / menú | `AGENT_DATABASE_URL` | `migrations-agent/` | `npm run migrate:agent:up` / `:down` / `:plan` |

`:plan` = `up --dry-run`: imprime el SQL de las migraciones y no las ejecuta, PERO node-pg-migrate
igual crea la tabla vacía `pgmigrations` en la base (no es una migración). Si no quieres ni eso, revisa
los archivos de esta carpeta a mano. Cada base guarda su propia tabla `pgmigrations`. Nunca uses la misma URL en las dos variables.

## Tablas de la DB Agente

`webhook_events`, `agent_conversations`, `agent_messages`, `agent_runs`,
`agent_control_events`, `menu_sessions`, `menu_send_deliveries`.
No hay claves foráneas ni joins hacia Central (`menu_sessions.replaces_order_id` es un uuid
suelto). La comunicación entre ambas bases es por servicios de Nest.

## Adoptar una DB Agente que ya existe

Las migraciones `…031`–`…033` son la base y son idempotentes (`create … if not exists`): sobre
una base que ya tiene las tablas (la real, con la forma de sarcoRestaurant) no cambian nada.
`…036` es el DELTA con todo lo que esa base real NO tiene: `webhook_events.claim_token` /
`claimed_until` (+ índice de leases vencidos + CHECK), el índice único parcial
`uq_agent_messages_provider_message_id` (con comprobación previa de duplicados), `ix_agent_messages_recent`
e `idx_menu_sessions_customer_phone`.

Antes de correr nada contra una base real:

1. Ejecuta `scripts/agent-db-introspect.sql` en esa base (solo lectura) y compara con la
   auditoría de compatibilidad.
2. `npm run migrate:agent:plan` para ver el SQL exacto.
3. Recién entonces `npm run migrate:agent:up`.

Las migraciones `Down` de esta carpeta están vacías a propósito: adoptan tablas con datos y
no deben borrarlas.

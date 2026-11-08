# Integración con la plataforma central de reparto (Smarky)

Zarco puede pedir sus repartidores a la plataforma central de reparto, que da al
cliente un link de seguimiento en vivo. Es **opcional y está apagado por defecto**:

| `DELIVERY_PROVIDER` | Comportamiento |
|---|---|
| `internal` (default, o sin la variable) | Idéntico al de siempre: repartidores propios + aviso al grupo de Telegram. |
| `smarky` | Pide repartidor a la plataforma; si la plataforma falla, cae al flujo de siempre. |

Contrato de la plataforma: `smarky-delivery-platform/docs/openapi.yaml`.

## Qué hace con `smarky`

1. Cuando el pedido de delivery queda elegible (QR pagado, split completo pagado, o
   efectivo ya cotizado) y `DeliveryNoticesService.notifyConfirmed` corre, se llama a
   `SmarkyDeliveryService.dispatchForOrder`: cotiza con el pin, pide la entrega
   (`externalOrderId` = id del pedido, `orderLabel` = `ORD-N`) y guarda en `orders`
   `smarky_delivery_id`, `smarky_tracking_url`, `smarky_delivery_status`.
2. Si la plataforma tomó el pedido **no se avisa al grupo de repartidores propios**
   (nunca se avisa dos veces). Si falló o no aplicó, el aviso al grupo sale como siempre.
3. Los repartidores propios no ven ni aceptan pedidos que tiene la plataforma
   (`GET /delivery/orders/available` y `accept` los excluyen). Si la plataforma abandona
   la entrega (`cancelled`/`failed`) el pedido vuelve a estar disponible para ellos.
4. El cliente recibe **un WhatsApp** (texto directo por el gateway) que abre con
   "¡Listo! Tenemos tu pedido ORD-N confirmado…", el link de seguimiento y el código de
   entrega. El código **no se guarda ni se escribe en logs**. Si el envío falla se reintenta
   con un código nuevo; si vuelve a fallar sale por `notification_jobs` solo con el link.
   Es un mensaje adicional a la confirmación estructurada: quien usa el checkout nativo
   no recibe esa confirmación por WhatsApp (el agente la suprime), así que ve uno solo.
5. Webhook `POST /integrations/smarky/webhook`, firmado con HMAC-SHA256 sobre el cuerpo
   crudo (`Smarky-Signature: t=…,v1=…`, tolerancia 5 min) e idempotente por `eventId`
   (tabla `smarky_webhook_events`). Estados: `in_transit` → pedido `out_for_delivery`
   (con `delivery_driver_name='Plataforma de reparto'` y `delivery_accepted_at`, para el
   monitor del POS); `delivered` → `delivered` (+ `delivered_at`).
   **`cancelled`/`failed` NO cancelan el pedido** (ya está pagado): se guarda el estado,
   se avisa una vez al grupo de reparto y el pedido vuelve a los repartidores propios.
6. Efectivo: la plataforma se usa también para pedidos en efectivo, pero Zarco **no toca**
   `cash_confirmed_at` ni `payment_status` al entregar. El cobro sigue siendo un proceso
   humano (la moto le paga al cajero) y el cuadre de motos no cambia.
7. `GET /internal/agent/orders/tracking?customerPhone=` (solo con bearer de servicio):
   link y estado del pedido en curso, para el agente. Nunca devuelve el código.

## Variables (al final de `.env.example`)

```
DELIVERY_PROVIDER=internal
SMARKY_BASE_URL=
SMARKY_API_KEY=
SMARKY_WEBHOOK_SECRET=
```

Las entrega el panel de la plataforma; **nunca** se commitean ni se imprimen. Con
`smarky` y alguna de `SMARKY_BASE_URL`/`SMARKY_API_KEY` vacía, el backend lo registra en el
log y usa el reparto interno. El webhook solo existe con `smarky` + `SMARKY_WEBHOOK_SECRET`
(con `internal` responde 404).

URL a registrar en el panel de la plataforma:
`https://<dominio-del-backend>/integrations/smarky/webhook`

## Migración (aditiva)

`migrations/1700000043000_smarky-delivery.sql`: tres columnas nulas en `orders`
(`smarky_delivery_id`, `smarky_tracking_url`, `smarky_delivery_status`), un índice único
parcial y la tabla `smarky_webhook_events` (con RLS, como el resto). No modifica ni borra
datos y el código anterior sigue funcionando con las columnas presentes.

**Las migraciones no corren solas.** Se aplican a mano:

```bash
# DATABASE_URL = la de Zarco_Base (producción). Respaldo ANTES, siempre:
pg_dump "$DATABASE_URL" -Fc -f zarco_base_antes_reparto_$(date +%F).dump
npm run migrate:up
```

> **Aplicar la migración ANTES de desplegar el código nuevo.** El filtro de repartidores
> propios consulta `orders.smarky_delivery_status`; con el código nuevo y sin la columna,
> la lista y el "aceptar" de los repartidores darían error. Con la migración ya aplicada,
> el código viejo no se entera.

Dónde correrla: `node-pg-migrate` está en `devDependencies`. En la terminal del contenedor
de Dokploy comprueba primero `npx node-pg-migrate --version`; si no está, córrela desde una
copia de esta rama en tu máquina con `DATABASE_URL` apuntando a la base (con acceso de red).
Para ver qué aplicaría sin ejecutar: `npx node-pg-migrate up --dry-run -m migrations --migration-file-language sql`.

## Orden de despliegue (backend en Dokploy, `Backend_Central`)

Dokploy usa proveedor Git **sin autodeploy**: nada se despliega al hacer push.

1. **Respaldo** `pg_dump` de `Zarco_Base` (comando de arriba). Guarda el archivo fuera del VPS.
2. **Migración**: `npm run migrate:up` (ver arriba) — antes del código nuevo.
3. **Desplegar el backend** (rama `feat/integracion-plataforma-reparto`) en Dokploy con
   `DELIVERY_PROVIDER=internal`. Anota el id/nombre del deployment anterior para el rollback.
   Comprueba que todo sigue igual: crear un pedido, pagar, ver el aviso al grupo.
4. **Webhook**: poner `https://<dominio-del-backend>/integrations/smarky/webhook` en el
   panel de la plataforma y copiar el secreto a `SMARKY_WEBHOOK_SECRET`.
5. **Agente** (Railway, `agent-pedilo`): ver `docs/integracion-reparto-smarky.md` del repo del
   agente. Push de su rama y cambio de rama en Railway solo cuando se decida; el agente
   tolera un backend viejo, así que el orden entre 3 y 5 no es crítico.
6. **Activar**: en Dokploy poner `DELIVERY_PROVIDER=smarky`, `SMARKY_BASE_URL`,
   `SMARKY_API_KEY`, `SMARKY_WEBHOOK_SECRET` y **redesplegar** (las variables se leen al
   arrancar). Probar con un pedido real de bajo riesgo.

## Rollback (dos niveles)

1. **Apagar sin tocar código**: `DELIVERY_PROVIDER=internal` y redesplegar en Dokploy. El
   flujo vuelve a ser exactamente el de siempre. Los pedidos que la plataforma ya tenía
   siguen mostrándose con su link y el webhook deja de aceptarse (404); si hay alguno en
   curso, atiéndelo a mano o con repartidores propios (quedan ocultos para ellos mientras su
   `smarky_delivery_status` no sea `cancelled`/`failed`: en ese caso límpialo con
   `update orders set smarky_delivery_status = null where id = '<pedido>'`).
2. **Volver al código anterior**: en Dokploy, redesplegar el deployment/commit anterior
   (`c7bcc95` de `master`). La migración **no se revierte**: es aditiva y el código viejo la
   ignora. Solo si hiciera falta quitarla: `npm run migrate:down` (borra las columnas y
   la tabla — después de un respaldo).

## Pruebas

`npm test` (los 12 fallos de `order-replacement.service.spec` dependen de la hora y de la
caja abierta y ya fallaban en `master`). Con `internal` los tests demuestran que no se
invoca la plataforma, el aviso al grupo sale igual y el filtro de repartidores no excluye nada.

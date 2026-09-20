# Backend Central de Negocio (La Fija)

NestJS + Postgres. Diseño completo en
`C:\Users\julio\.claude\plans\kind-spinning-donut.md`.

## Setup

```bash
npm install
cp .env.example .env   # completar DATABASE_URL (Postgres propio, credenciales
                        # propias — nunca la service_role de Supabase) y los
                        # demás valores
npm run migrate:up     # aplica migrations/ contra DATABASE_URL

# Primer usuario de staff. POST /auth/users exige un admin ya logueado, así
# que el arranque en frío va por acá (la contraseña sale de ADMIN_PASSWORD
# para no dejarla en el historial del shell).
ADMIN_PASSWORD='...' npm run create-admin -- <username> admin

npm run start:dev
```

`CORS_ORIGINS` tiene que incluir el origen de cualquier front en el navegador
(POS, dashboard) o el preflight falla; los clientes que no son navegadores no
lo necesitan. En desarrollo, `http://localhost:5173`.

## Contrato de la API

`/docs` (Swagger UI) y `/docs-json` (OpenAPI) se generan solos desde los tipos
de TypeScript, vía el CLI plugin de `@nestjs/swagger` declarado en
`nest-cli.json`. El front genera sus tipos de request desde `/docs-json` con
`openapi-typescript` en vez de mantenerlos a mano.

**Limitación actual**: los tipos de *response* (`OrderResponse`,
`ProductResponse`, etc.) son `interface`s de TypeScript, que no existen en
runtime — el plugin no puede generar su schema y salen como `object` vacío en
el OpenAPI. Para que el front también genere las respuestas habría que
convertirlas en `class` con `@ApiProperty()`.

## Estructura

- `migrations/` — SQL portado 1:1 del esquema de referencia del plan
  (categories, products, customers, idempotency_keys, orders/order_items,
  late_order_requests, delivery_tariff_bands/delivery_quote_requests,
  payment_attempts/payment_proofs, promotions/promotion_items/
  order_promotions, operational_settings, dashboard_users,
  notification_jobs).
- `src/database/` — `Kysely<Database>` tipado sobre `pg`, inyectable como
  `KYSELY` en cualquier servicio.
- `src/common/` — guard de auth entre servicios (bearer token estático por
  `api_client`, comparación timing-safe), `IdempotencyService` genérico
  (header `Idempotency-Key`), excepciones/filtro de dominio (`{code,
  message, details}`, nunca texto crudo de Postgres).
- `src/auth/` — login JWT (`dashboard_users`, bcrypt) para sesión de staff,
  `JwtAuthGuard` + `RolesGuard` + `@Roles(...)` para RBAC. Dos capas de auth
  conviven sobre el mismo header `Authorization: Bearer`:
  `ServiceAuthGuard` (bearer estático, tokens de `SERVICE_AUTH_TOKENS`)
  autentica de qué sistema viene la llamada (whatsapp-gateway, pos, web);
  `JwtAuthGuard` autentica qué persona de staff la hizo. Tres casos:
  - **Solo servicio** — lo que solo llama el gateway de WhatsApp
    (`/delivery`, `/payment-proofs`, `location`, `switch-to-pickup`).
  - **Solo JWT** — decisiones humanas con rol (mantenimiento de menú,
    tablero de cocina, aceptar/rechazar pedidos tardíos, cobro QR presencial).
  - **Cualquiera de los dos** (`ServiceOrStaffAuthGuard`) — lo que llaman
    tanto el gateway como el POS: catálogo, `POST /orders`, `GET /orders/:id`,
    cobro en efectivo, clientes. Existe para que el POS en el navegador use
    solo la sesión del cajero y no tenga que embeber un token de servicio,
    que no vence, en el bundle. Una request autenticada por JWT queda marcada
    con `apiClient = 'pos'`, que es el scope de idempotencia de
    `POST /orders`.
- `src/gateway-client/` — cliente HTTP hacia el "gateway API" que expondrá
  `saas_smarky` (`/gateway/whatsapp/messages`, `/gateway/whatsapp/
  location-requests`, `/gateway/telegram/alerts`).
- `src/notifications-out/` — tabla única de trabajos de aviso
  (`notification_jobs`): camino rápido de envío inmediato +
  `NotificationRecoveryCron` (cada minuto) que reintenta con backoff
  exponencial lo que quedó `pending`/`failed`.
- Un módulo por dominio de negocio (`categories`, `products`, `customers`,
  `promotions`, `operational-settings`, `orders`, `delivery`,
  `payment-attempts`, `payment-proofs`, `late-order-requests`, `auth`,
  `cash-register`, `baneco`, `bank-qr`, `reports`).

## Qué está implementado

Todo lo siguiente está implementado, probado con tests unitarios/integración
y verificado manualmente de punta a punta contra un proyecto Supabase de
prueba (categorías → productos → cliente → pedido → delivery → comprobante
→ decisión de pago → aviso), incluyendo el gateway de WhatsApp/Telegram
simulado:

- **`categories`, `products`, `customers`, `promotions`** (CRUD completo,
  `status` calculado), **`operational-settings`** (horario, recargo por
  lluvia, coordenadas del restaurante). Escritura protegida por JWT +
  `@Roles('admin')` (disponibilidad de producto también admite `kitchen`).
  `GET /categories` y `GET /products` filtran los inactivos por defecto
  (lo que consume el catálogo de venta); `?includeInactive=true` los trae
  también, para el mantenimiento de menú (poder reactivarlos).
  `products` incluye foto: `POST /products/:id/image` (JWT, rol `admin`,
  base64 en el body como `payment-proofs`, máx. 5 MB, reemplaza la anterior)
  y `GET /products/:id/image` (mismo guard que el catálogo, `imageUrl` en
  `ProductResponse` es la ruta relativa o `null`) — se sirve siempre a
  través del backend, nunca una URL directa al bucket, mismo adaptador de
  storage intercambiable (S3/R2 o disco local) que `payment-proofs`,
  reusando el mismo bucket.
  **Complementos** (`product_complements`, ej. tomate/lechuga/cebolla/
  quirquiña): lista por producto, sin precio propio (solo exclusión).
  `complements[]` en `POST/PATCH /products` reemplaza la lista completa
  (mismo patrón que `promotions.items`); `ProductResponse.complements[]`
  siempre viene en el catálogo, para que el cliente sepa qué se puede
  destildar.
- **`orders`** — `POST /orders` porta `create_order_web_v5` (saas_smarky)
  completo: gate de horario en dos capas, porque el horario real no es fijo
  (varía ±1h noche a noche). `business_opens_hour`/`business_closes_hour`
  en `operational_settings` (hora de La Paz, el turno puede cruzar
  medianoche — ej. 19 a 4, comparado relativo a la apertura, no horas
  absolutas del día) son solo un margen ANCHO de cordura para descartar de
  una un mensaje fuera de cualquier horario plausible (ej. cerrado 6am-4pm).
  Adentro de ese margen, la caja abierta (`cash-register`, abajo) decide si
  el pedido se confirma directo o se encola (`late_order_requests`) — ver
  `common/time/service-window.ts`. `Idempotency-Key` genérica reemplazando
  sesión+fingerprint, recálculo de precios/disponibilidad en servidor,
  snapshot de productos y combos, `product_unavailable` vs
  `promotion_unavailable`. Más `location` (dispara cotización de delivery),
  `kitchen-note`, `switch-to-pickup`, `cash/confirm`/`cash/cancel`,
  `PATCH /status` (transición legal + CAS optimista, requiere JWT +
  rol `kitchen`/`admin` y guarda `status_updated_by`; bloquea
  `confirmed → preparing` con `409 payment_required` si `payment_status`
  no es `paid` — excepto delivery + `cash`, el único caso real de pago
  contra entrega, donde el repartidor cobra al llegar),
  `GET /orders` (tablero de cocina/cuadre de caja, rol `kitchen`/
  `cashier`/`admin`) con filtros (`customer_id`, `status`,
  `delivery_type`, `payment_status`) + paginación (`limit`/`offset`) —
  `delivery_type=delivery&payment_status=unpaid` es la cola de "cuadre con
  las motos" a fin de noche. `GET /orders/:id` (un solo pedido) sigue con
  el token de servicio o cualquier JWT. `cash/confirm` y la decisión QR que
  marca `accepted` vinculan el pedido a la caja abierta en ese momento (ver
  `cash-register` abajo) — exigen que haya una.

  **Complementos por línea**: `items[].excludedComplements` (nombres a
  sacar, ej. `["quirquiña"]`) — por defecto todos van incluidos. Dos líneas
  del mismo `productId` son válidas si difieren en la selección (ej. "3
  normales + 1 sin quirquiña" son dos `order_items`, nunca se fusionan
  porque perderían cuál unidad lleva qué); repetir la misma combinación en
  dos líneas da `400 validation_error`, y un nombre que el producto no
  tiene da `400 unknown_complement`. Snapshot en
  `order_items.excluded_complements` (texto, no id — igual que
  `product_name_snapshot`, no se recalcula si después el admin edita el
  catálogo).

  **`POS_QR_MODE=manual`** (variable de entorno, mientras el banco no
  habilite producción del QR): para `channel='pos'` únicamente,
  `POST /orders/:id/qr/generate` responde `409 qr_manual_mode` en vez de
  llamarlo — el front del POS no muestra ningún QR generado por el sistema;
  el cajero verifica el pago a ojo (con su propio QR, fuera del sistema) y
  confirma con `POST /orders/:id/payment-attempts/confirm-presencial`
  (`{decision: "accepted"}`), que ya soportaba crear+decidir sin que exista
  un `payment_attempt` previo. `notifyOrderCreated` tampoco intenta generar
  el QR real ni le manda nada al cliente por WhatsApp para esos pedidos.
  WhatsApp no se toca — sigue con el QR real de Baneco siempre. Sin la
  variable (o con cualquier otro valor), comportamiento normal. Cuando el
  banco apruebe producción, se saca la variable en Railway — sin tocar
  código ni mergear ramas.

  **QR nunca cobra el envío**: con `paymentMethod: 'qr'`, el monto cobrado
  (por `QrPaymentsService` y por el `confirm-presencial` manual) es siempre
  `subtotal_amount` — nunca `total_amount`. Ya no hay contra entrega de la
  comida en ningún caso; el envío (si es delivery) sigue siendo cobro
  presencial del repartidor, fuera del sistema (no hay ninguna columna que
  lo registre — es operativo, no una transacción).

  **Pago dividido (POS presencial)**: `POST /orders/:id/split-payment`
  (JWT, `cashier`/`admin`; body `{cashAmount, qrAmount}`, deben sumar
  exacto `total_amount` o `400`) pasa `payment_method` a `'split'`. Cada
  pata se confirma con el endpoint que ya existía para ese método
  (`cash/confirm`/`cash/cancel` para la pata efectivo —
  `split_cash_confirmed_at`, columna propia, nunca `cash_confirmed_at` —, y
  `qr/generate`/`confirm-presencial` para la pata QR, cobrando
  `split_qr_amount` en vez de `subtotal_amount`). `payment_status` pasa a
  `'paid'` recién cuando **las dos** patas están confirmadas, en cualquier
  orden; cancelar la pata efectivo vuelve todo a `'unpaid'` aunque la QR ya
  estuviera aceptada. El cierre de caja (`cash-register`, abajo) reparte
  el `total_amount` de un split entre efectivo y QR usando
  `split_cash_amount`/`split_qr_amount`, no lo cuenta entero de un lado.
- **`delivery`** — bandas de tarifa reales portadas de `delivery-tariff-v2`
  (16 bandas, techo automático 16 km → `pending_manual`, recargo por lluvia
  congelado en la misma transacción). Distancia vía `DistanceService`
  intercambiable: `MapboxDistanceService` (Directions API, perfil driving)
  ya implementado y se activa solo con `MAPBOX_ACCESS_TOKEN` en `.env`; sin
  token (o si la API falla/tarda más de 4s) usa línea recta (`Haversine`)
  automáticamente — el `distance_source` persistido siempre refleja cuál se
  usó de verdad.
- **`late-order-requests`** — `accept`/`reject` requieren JWT + rol `admin`
  o `cashier` (`decidedBy` es el username del staff autenticado, no un
  api_client de servicio). `accept` exige una caja abierta (un pedido fuera
  de horario se vincula a la sesión ahí mismo, sea cash o QR — es el
  momento en que entra oficialmente al turno) y revalida el carrito
  completo reusando `OrdersService.createOrderInTransaction` (con
  `SAVEPOINT` propio) y solo entonces marca `accepted` con su `order_id`;
  fallos permanentes quedan `rejected` con motivo, nunca en bucle; sin caja
  abierta tira `409 cash_register_closed` sin tocar nada — la solicitud
  sigue `pending` para reintentar. `GET /late-order-requests` lista la cola
  (`pending` por defecto) para el dashboard.
- **`payment-attempts`** — CAS puro `pending_review → accepted|rejected`
  con el índice único parcial como garantía de esquema. Cuando el CAS lo
  gana ESTA llamada (`won: true`), en la misma transacción propaga a
  `orders.payment_status` (`paid`/`rejected`) y dispara un aviso best-effort
  al cliente — nunca si `won: false`, para no duplicar el efecto.
  `POST /orders/:id/payment-attempts/confirm-presencial` (JWT, rol
  `cashier`/`admin`) es el fallback manual del cobro QR en el mostrador: si
  ya hay un intento vivo (lo normal, dejado por `QrPaymentsService` al
  generar el QR real) decide sobre ese; si no, crea y decide en un solo
  paso. Sigue protegido por el mismo índice único
  (`uq_payment_attempts_live`), así que no se puede confirmar dos veces ni
  pisar un intento por foto que haya llegado casi al mismo tiempo.
- **`reports`** — reportería y KPIs, solo lectura y solo `admin`
  (`GET /reports/kpis|sales/timeseries|sales/orders|sales/orders/:id|
  products/top|cash-sessions`). "Vendido" = pagado y no cancelado, fechas en
  hora de Bolivia, y `session_id` para cuadrar contra el cierre de caja. Sin
  tablas nuevas; no hay tiempos de preparación por etapa porque no existe
  historial de estados. Detalle en `docs/reports-integration.md`.
- **`cash-register`** — apertura/cierre de caja (turno). Una sola sesión
  `status='open'` a la vez para todo el local (índice único parcial), rol
  `admin`/`cashier` (`POST /cash-register/sessions/open|close`, `GET
  .../current` para cualquier staff, `GET .../:id` e historial para
  admin/cashier). No es "solo plata física": agrupa cualquier pedido que se
  confirma pagado (cash o QR) durante la sesión — el rango
  `opened_at..closed_at` ES el "día de negocio", necesario porque el turno
  real cruza medianoche. Un pedido normal se vincula recién cuando su pago
  se confirma de verdad (`cash/confirm`, o la decisión QR que lo marca
  `accepted`); uno fuera de horario se vincula al aceptarse (ver
  `late-order-requests`). Consecuencia: **confirmar cualquier pago exige
  caja abierta** — `409 cash_register_closed` si no la hay. El cierre
  calcula `expectedCashAmount`/`cashDifference` contra `countedCashAmount`
  y reporta `totalCashSalesAmount`/`totalQrSalesAmount`/`totalSalesAmount`,
  todo calculado y congelado en el momento del cierre (no se recalcula
  después). `GET .../current` agrega `liveTotals` con esas mismas sumas
  calculadas al vuelo sobre la sesión abierta, para que el POS muestre cómo
  va la caja durante el turno; los campos congelados de la raíz siguen en
  `null` hasta cerrar.
- **`payment-proofs`** — intake completo: idempotencia por
  `source_message_id`, algoritmo de asociación `resolveAssociation` portado
  de saas_smarky (niveles reply_to_qr / candidatos estructurales / ventanas
  de 4h-24h, con `candidate_count` persistido para auditoría), routing bajo
  `pg_advisory_xact_lock` por cliente con `SAVEPOINT`s replicando las
  subtransacciones del RPC original, y un adaptador de storage
  intercambiable (`PaymentProofStorage`): `S3PaymentProofStorage` (AWS S3 o
  cualquier S3-compatible — Cloudflare R2, MinIO — vía `endpoint`) ya
  implementado y se activa solo con `PAYMENT_PROOFS_S3_BUCKET` +
  credenciales en `.env`; sin bucket configurado usa disco local
  automáticamente, mismo patrón de auto-selección que `DistanceService`.
- **`baneco` / `bank-qr`** — QR real de Banco Económico. `BanecoClientService`
  (`src/baneco/`) es el cliente HTTP crudo (`encrypt`/`authenticate`/
  `generateQR`/`statusQR`/`cancelQR`, validado en certificación contra el
  manual del banco; token cacheado en memoria con reautenticación en 401).
  `QrPaymentsService` (`src/bank-qr/`) es la capa de dominio:
  `generateForOrder` es idempotente (reusa el intento vivo si ya existe) y
  crea un `payment_attempts` en `pending_review` igual que hoy con una foto
  recién asociada — la confirmación real (`resolveCharge`) llama
  `paymentAttempts.decide(..., 'accepted')`, reusando 100% el CAS, el
  vínculo a caja y la notificación al cliente que ya existían. Como el banco
  no validó todavía `notifyPaymentQR` (su propio manual lo marca
  "pendiente"), el mecanismo principal es un cron (`QrPaymentsPollCron`,
  cada 5s) que usa `statusQR` — sí validado — sobre cada QR pendiente; el
  webhook `POST /api/qrsimple/notifyPaymentQR` (ruta, formato de request y
  respuesta `{responseCode, message}` calcados de la sección 6.5 del manual
  del banco) solo dispara esa misma re-verificación, nunca confía en el body
  (el manual no define auth para esa dirección — el Bearer es solo para
  comercio → banco). El `qrId` se acepta envuelto en `Payment`, en `payment`
  o plano en la raíz, porque el manual declara el objeto pero no da un JSON
  de ejemplo (ver `notify-payment.ts` y su spec).
  `POST /orders/:id/qr/generate` (JWT, `cashier`/`admin`) es la acción
  explícita del POS; el canal WhatsApp lo genera solo al crear el pedido
  (`orders.service.ts`, cae al texto de pedir captura si el banco falla).

  **Pago cobrado que no se puede aplicar**: `decide()` exige caja abierta,
  así que un pago que entra después del cierre no se puede aplicar. El orden
  importa y es deliberado: primero `decide()`, y recién si sale bien se marca
  el cobro `confirmed` — al revés, marcar `confirmed` primero haría que el
  cron dejara de mirar ese qrId (solo barre `pending`) y la plata quedaría
  cobrada en el banco con el pedido impago, sin reintento. Si falla por caja
  cerrada se anota `paid_detected_at` y se reintenta durante un margen de
  gracia de 10 min (cubre el cierre corto por cambio de turno, ver
  `unapplied-payment.ts`); pasado el margen el cobro queda `paid_unapplied`
  y se dispara una alerta a Telegram al staff. Aplicar ese pago a la caja del
  día siguiente sería peor que no aplicarlo: entraría en el cuadre de otra
  jornada y el pedido de anoche ya no se va a cocinar. La resolución es
  humana: `GET /bank-qr/unapplied-payments` (JWT, `cashier`/`admin`) lista la
  cola con teléfono del cliente para poder contactarlo, `POST
  /bank-qr/unapplied-payments/:id/apply` lo aplica si el local sigue abierto,
  y `POST /bank-qr/unapplied-payments/:id/refunded` (rol `admin`) deja
  registro de que ya se le devolvió la plata — el banco **no expone ninguna
  API de devolución** (manual v1.0.0: solo generar, anular, consultar y
  listar pagados), así que devolver es siempre manual y esto es solo la
  traza.
- **`auth`** — login JWT contra `dashboard_users` (bcrypt). Alta de staff
  vía API (`POST /auth/users`, `GET /auth/users`, `PATCH
  /auth/users/:id/active`), protegida con `@Roles('admin')` — el primer
  admin se crea con `npm run create-admin` (ver Setup arriba), ya que
  `POST /auth/users` exige estar logueado como admin.
- **`customers.findOrCreate`** — si `phone` y `email` llegan juntos y cada
  uno ya pertenece a un cliente distinto, se traduce a un 409
  (`customer_identity_conflict`) en vez de dejar escapar el unique
  violation crudo de Postgres.

## Qué falta / deuda conocida

- **Pago con QR bancario — pago real sin validar todavía**: Banco Económico
  solo confirmó `generateQR`/`statusQR`/`cancelQR` en certificación;
  `statusQrCode = 1` (pago real) y el webhook `notifyPaymentQR` siguen
  "pendiente" según su propio manual. El código está listo para ambos casos
  (polling ya funcional contra lo validado, webhook ya recibido pero
  tratado solo como señal de "revisá ya", nunca como fuente de verdad) —
  falta que el banco habilite una prueba de pago real en certificación para
  confirmar de punta a punta, y después pedir credenciales de producción
  (mismas env vars `BANECO_*`, sin cambios de código esperados).

  **URL del webhook para darle al banco**:
  `https://backend-central-zarco-production.up.railway.app/api/qrsimple/notifyPaymentQR`
- **`paidQR` sin usar**: la sección 6.6 del manual expone
  `GET /api/qrsimple/paidQR` con la lista de QR pagados de una fecha, pensada
  justamente para conciliación. Sería una red de seguridad mejor (y mucho más
  barata) que el cron de 5s: un barrido por día detecta cualquier pago que el
  webhook y el polling hayan perdido. Hoy no está implementado.

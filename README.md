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
  `payment-attempts`, `payment-proofs`, `late-order-requests`, `auth`).

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
- **`orders`** — `POST /orders` porta `create_order_web_v5` (saas_smarky)
  completo: gate de horario (17-22 abierto, 22-23 revisión nocturna, cierre
  a las 23, hora de La Paz), `Idempotency-Key` genérica reemplazando
  sesión+fingerprint, recálculo de precios/disponibilidad en servidor,
  snapshot de productos y combos, `product_unavailable` vs
  `promotion_unavailable`. Más `location` (dispara cotización de delivery),
  `kitchen-note`, `switch-to-pickup`, `cash/confirm`/`cash/cancel` (CAS),
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
  el token de servicio o cualquier JWT.
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
  api_client de servicio). `accept` revalida el carrito completo reusando
  `OrdersService.createOrderInTransaction` (con `SAVEPOINT` propio) y solo
  entonces marca `accepted` con su `order_id`; fallos permanentes quedan
  `rejected` con motivo, nunca en bucle. `GET /late-order-requests` lista
  la cola (`pending` por defecto) para el dashboard.
- **`payment-attempts`** — CAS puro `pending_review → accepted|rejected`
  con el índice único parcial como garantía de esquema. Cuando el CAS lo
  gana ESTA llamada (`won: true`), en la misma transacción propaga a
  `orders.payment_status` (`paid`/`rejected`) y dispara un aviso best-effort
  al cliente — nunca si `won: false`, para no duplicar el efecto.
  `POST /orders/:id/payment-attempts/confirm-presencial` (JWT, rol
  `cashier`/`admin`) cubre el cobro QR en el mostrador: crea y decide el
  intento en un solo paso, sin foto ni `payment-proofs` — sigue protegido
  por el mismo índice único (`uq_payment_attempts_live`), así que no se
  puede confirmar dos veces ni pisar un intento por foto que haya llegado
  casi al mismo tiempo. Es provisorio hasta que entre la API de banco.
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
- **`auth`** — login JWT contra `dashboard_users` (bcrypt). Alta de staff
  vía API (`POST /auth/users`, `GET /auth/users`, `PATCH
  /auth/users/:id/active`), protegida con `@Roles('admin')` — el primer
  admin se sigue creando por SQL directo (arranque en frío inevitable).
- **`customers.findOrCreate`** — si `phone` y `email` llegan juntos y cada
  uno ya pertenece a un cliente distinto, se traduce a un 409
  (`customer_identity_conflict`) en vez de dejar escapar el unique
  violation crudo de Postgres.

## Qué falta / deuda conocida

- **Pago con QR bancario**: pendiente a propósito (dependencia externa aún
  no definida). El plan menciona una integración próxima con una API de
  banco. Hoy `payment_method: 'qr'` asume comprobante manual (foto) vía
  WhatsApp; cuando llegue la integración bancaria, probablemente cree
  `payment_attempts`/decisiones de forma automática en vez de por
  `payment-proofs` — diseñar esa entrada sin romper el CAS existente (el
  efecto downstream en `payment-attempts.decide()` ya está listo para
  reutilizarse desde ahí).

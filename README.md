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
npm run start:dev
```

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
- `src/gateway-client/` — cliente HTTP hacia el "gateway API" que expondrá
  `saas_smarky` (`/gateway/whatsapp/messages`, `/gateway/whatsapp/
  location-requests`, `/gateway/telegram/alerts`).
- `src/notifications-out/` — tabla única de trabajos de aviso
  (`notification_jobs`), camino rápido de envío inmediato.
- Un módulo por dominio de negocio (`categories`, `products`, `customers`,
  `promotions`, `operational-settings`, `orders`, `delivery`,
  `payment-attempts`, `payment-proofs`, `late-order-requests`, `auth`).

## Qué está implementado

Todo lo siguiente está implementado, probado con tests unitarios/integración
y verificado manualmente de punta a punta contra un proyecto Supabase de
prueba (categorías → productos → cliente → pedido → delivery → comprobante
→ decisión de pago), incluyendo el gateway de WhatsApp/Telegram simulado:

- **`categories`, `products`, `customers`, `promotions`** (CRUD completo,
  `status` calculado), **`operational-settings`** (horario, recargo por
  lluvia, coordenadas del restaurante).
- **`orders`** — `POST /orders` porta `create_order_web_v5` (saas_smarky)
  completo: gate de horario (17-22 abierto, 22-23 revisión nocturna, cierre
  a las 23, hora de La Paz), `Idempotency-Key` genérica reemplazando
  sesión+fingerprint, recálculo de precios/disponibilidad en servidor,
  snapshot de productos y combos, `product_unavailable` vs
  `promotion_unavailable`. Más `location` (dispara cotización de delivery),
  `kitchen-note`, `switch-to-pickup`, `cash/confirm`/`cash/cancel` (CAS),
  `PATCH /status` (transición legal + CAS optimista).
- **`delivery`** — bandas de tarifa reales portadas de `delivery-tariff-v2`
  (16 bandas, techo automático 16 km → `pending_manual`, recargo por lluvia
  congelado en la misma transacción). Distancia por ahora en línea recta
  (`DistanceService` intercambiable — falta conectar Mapbox u otro proveedor
  de ruteo real).
- **`late-order-requests`** — `accept` revalida el carrito completo
  reusando `OrdersService.createOrderInTransaction` (con `SAVEPOINT` propio)
  y solo entonces marca `accepted` con su `order_id`; fallos permanentes
  quedan `rejected` con motivo, nunca en bucle.
- **`payment-attempts`** — CAS puro `pending_review → accepted|rejected`
  con el índice único parcial como garantía de esquema.
- **`payment-proofs`** — intake completo: idempotencia por
  `source_message_id`, algoritmo de asociación `resolveAssociation` portado
  de saas_smarky (niveles reply_to_qr / candidatos estructurales / ventanas
  de 4h-24h), routing bajo `pg_advisory_xact_lock` por cliente con
  `SAVEPOINT`s replicando las subtransacciones del RPC original, y un
  adaptador de storage intercambiable (`PaymentProofStorage`) — hoy en
  disco local, listo para swap a S3/R2 con credenciales reales.
- **`auth`** — login JWT contra `dashboard_users` (bcrypt), guard +
  decorador de roles (`@Roles(...)`) listos para usar.

## Qué falta / deuda conocida

- **Mapbox real**: `DeliveryService` usa distancia en línea recta
  (haversine) — subestima la distancia de calle. Cambiar
  `HaversineDistanceService` por un adaptador Mapbox real en
  `delivery.module.ts`.
- **S3/R2 real**: `PaymentProofsModule` usa `LocalDiskPaymentProofStorage`
  — cambiar el provider por un adaptador S3/R2 cuando haya credenciales.
- **RBAC**: varios endpoints de staff (`categories`/`products`/
  `promotions` POST/PATCH, `operational-settings` PATCH, `late-order-
  requests` accept/reject) solo exigen el bearer de servicio, no un rol
  específico vía JWT — quedan marcados `TODO(auth)` en el código. El guard
  y el decorador de roles (`JwtAuthGuard` + `RolesGuard` + `@Roles()`) ya
  existen en `src/auth/`, falta aplicarlos.
- **Pago con QR bancario**: el plan menciona una integración próxima con
  una API de banco. Hoy `payment_method: 'qr'` asume comprobante manual
  (foto) vía WhatsApp; cuando llegue la integración bancaria, probablemente
  cree `payment_attempts`/decisiones de forma automática en vez de por
  `payment-proofs` — diseñar esa entrada sin romper el CAS existente.
- **Job de recuperación de `notification_jobs`**: el camino rápido
  (envío inmediato) está implementado; el cron de reintento con backoff
  sobre `status in ('pending','failed')` no.
- El `candidate_count` del algoritmo de asociación de `payment-proofs` no
  se persiste en BD (a diferencia del original) — es una simplificación
  deliberada, ver comentario en `payment-proofs.service.ts`.

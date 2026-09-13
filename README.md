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

## Qué está implementado vs qué es esqueleto

Siguiendo la estrategia de migración del plan (scaffold → lecturas → checkout
→ delivery → pagos → nocturnas/notificaciones → auth), en este scaffold:

**Implementado y probado (compila, arranca, rutas mapeadas):**
categories, products, customers, promotions (CRUD + `status` calculado),
operational-settings, y el mecanismo de CAS de `payment-attempts/:id/decide`
(invariante 5/6 — el efecto downstream sobre `orders`/notificaciones queda
como TODO explícito en el código).

**Esqueleto deliberado** (rutas y DTOs completos, servicio lanza
`NotImplementedException` con un TODO citando el invariante exacto del plan
que hay que respetar): `orders` (POST /orders — el corazón del sistema,
portar `create_order_web_v5`), `delivery` (cotización), `payment-proofs`
(intake + storage S3/R2), `late-order-requests` (accept/reject
transaccional), `auth` (decisión JWT vs sesión pendiente).

No se improvisó lógica de dinero/concurrencia en los módulos "esqueleto" —
el plan mismo separa esas fases para probarlas exhaustivamente antes de
seguir (ver "Verificación" en el plan, incluyendo los evals de concurrencia
a portar).

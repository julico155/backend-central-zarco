# Handoff: frontend del POS (para pegar como CLAUDE.md en el repo del front)

> Este archivo vive en el repo del backend solo como respaldo versionado.
> La copia que realmente importa es la que pegues en la raíz del repo del
> front como `CLAUDE.md` — Claude Code la carga sola en cada sesión de ese
> proyecto, en cualquier máquina.

## Qué estamos construyendo

Frontend (POS de mostrador + tablero de cocina + pantallas admin) para el
backend central de La Fija — NestJS + Postgres, ya en producción.

- **Backend en GitHub**: https://github.com/julico155/backend-central-zarco
- **Backend desplegado**: https://backend-central-zarco-production.up.railway.app
  (Swagger UI en `/docs`, OpenAPI crudo en `/docs-json` — ambos accesibles
  desde cualquier máquina con internet, son la fuente de verdad del contrato)
- **Doc de integración completa**: `docs/pos-integration.md` en ese repo
  (via GitHub si no tenés el repo clonado localmente en esta máquina)

Si tenés el tool WebFetch disponible, leé primero `/docs-json` del backend
desplegado y el `docs/pos-integration.md` de GitHub antes de escribir código.
Si no tenés acceso a internet en esta sesión, lo esencial ya está abajo.

## Decisiones ya tomadas (no las vuelvas a discutir salvo que encuentres un problema real)

| Decisión | Elección |
|---|---|
| Stack | Vite + React + TypeScript (app interna, sin SEO/SSR — Next.js sería peso muerto) |
| Routing | React Router |
| Estado de servidor | TanStack Query |
| Carrito | Zustand + persist (sobrevive a un refresh a mitad de venta) |
| UI | Tailwind + shadcn/ui |
| Formularios | react-hook-form + zod |
| Auth del POS | **Solo JWT de staff** (`POST /auth/login`), nunca un token de servicio en el navegador |
| Tipos de request | Generados desde `/docs-json` con `openapi-typescript` |
| Tipos de response | A mano por ahora (`OrderResponse` etc. son `interface`, no `class` — no generan schema en el OpenAPI) |
| Impresión | Térmica Epson TM-T20III vía Chrome `--kiosk-printing` contra el driver de Windows (no ePOS-Print directo: HTTPS→HTTP plano de la impresora es mixed content bloqueado) |
| Alcance | Venta + cocina + admin, todo en este repo separado del backend |

## Auth — lo único que necesitás saber

Un solo header `Authorization: Bearer <jwt>` en cada request. Se obtiene con
`POST /auth/login` (`{username, password}` → `{accessToken, user:{id,username,role}}`,
role es `admin`|`kitchen`|`cashier`). Dura 8h, no hay refresh token. Todo
`401` = re-login (el backend no distingue "vencido" de "inválido").

El backend tiene un guard compuesto en los endpoints de venta (catálogo,
`POST /orders`, `GET /orders/:id`, cobro en efectivo, clientes) que acepta
tanto un JWT de staff como un token de servicio — el POS usa siempre el JWT.

`forbidNonWhitelisted: true` global: **cualquier campo de más en el body da
400**. Serializá exactamente el contrato, nunca el objeto de estado tal cual.

## Gotchas del contrato que costó descubrir (no los re-derives, ya están verificados)

- **`GET /promotions` no filtra nada** (a diferencia de `/categories` y
  `/products`, que sí). Devuelve archivadas/inactivas/expiradas mezcladas —
  filtrá por `status === 'activa'` en el cliente.
- **`revision` de la promo**: guardalo al armar el carrito, va en
  `POST /orders`. Se incrementa al editar/activar/archivar una promo — un
  carrito viejo con `revision` desactualizado da 409 `promotion_unavailable`.
- **`OrderResponse` trae `items[]` (productos sueltos) Y `promotions[]`**
  (combos, con `componentsSnapshot[]` del detalle). `Σitems.subtotal` NO
  cuadra solo por sí mismo con `subtotalAmount` cuando hay combos — hay que
  sumar también `promotions[].subtotal`. Verificado en producción.
- **Carrito sin duplicados**: no se puede mandar el mismo `productId` dos
  veces — consolidá en una sola línea, `quantity` 1-10. Más de 10 unidades
  del mismo producto es inexpresable.
- **`Idempotency-Key`**: UUID v4 generado al abrir el carrito (no en el clic
  de confirmar — un doble clic con key nueva cobra dos veces). Mismo uuid en
  reintentos por timeout. **No reordenes `items[]`/`promotions[]` entre
  reintentos** — el hash del body es sensible al orden de los arrays.
  201 = venta nueva, 200 = respuesta cacheada (reimpresión, no recobro).
- **`bypassHoursGate: true` siempre**, junto con `channel: "pos"`,
  `deliveryType: "pickup"`.
- **Cobro QR presencial** (`POST /orders/:id/payment-attempts/confirm-presencial`)
  no devuelve el pedido, devuelve `{attempt, won}` — hacé `GET /orders/:id`
  después si necesitás el pedido actualizado para el ticket. Requiere rol
  `cashier` o `admin`. Es provisorio (viene una integración de banco real).
- **`GET /orders` (tablero)**: `customer_id` es snake_case, el resto no.
  Array pelado sin `total`. `limit` se recorta a 200 en silencio. `status`
  inválido devuelve `[]` sin avisar. No hay websockets — polling cada 5-10s.
- **`status_conflict` (409) ≠ `invalid_state_transition` (409)**: el primero
  es una carrera entre dos pantallas de cocina (CAS optimista) — refrescar y
  reintentar, no mostrar error rojo. El segundo es un salto de estado ilegal.
- **`status` y `paymentStatus` son independientes** — nada impide un pedido
  `delivered` + `unpaid`. Marcalo visualmente, el backend no avisa.
- **Errores**: forma uniforme `{code, message, details}`, salvo los 400 de
  class-validator donde `message` es un **array** de strings, no string.
- **Mantenimiento de menú**: `isAvailable` no se puede mandar a
  `PATCH /products/:id` (da 400) — va solo por
  `PATCH /products/:id/availability` con el campo **`available`** (no
  `isAvailable`). Promociones nuevas nacen inactivas, necesitan un segundo
  call a `PATCH /promotions/:id/active`. `items` de una promo exige 2
  elementos de producto distintos, no cuenta unidades.

## Estado del backend (ya hecho y verificado en producción — no lo toques)

CORS configurado (`CORS_ORIGINS` en Railway), guard de auth compuesto, RLS
activado en todas las tablas de Supabase, seed del primer admin
(`npm run create-admin` en el repo del backend), `OrderResponse` con
`promotions[]`. Todo probado end-to-end contra el backend real: login,
catálogo con JWT, crear pedido con combo, idempotencia con reintento, cobro
en efectivo — cuadró todo.

## Por dónde arrancar

Esqueleto del proyecto (Vite + React + TS) → cliente HTTP con manejo de JWT
y normalización de errores → pantalla de venta de mostrador. Antes de
escribir código, confirmá que entendiste el contrato de arriba.

# Integración del POS con el backend central

Este documento es para quien construya el front del POS. El backend ya
tiene toda la lógica de negocio (menú, pedidos, delivery, pagos) — el POS
es un cliente que solo llama a esta API, no reimplementa nada de eso.

**Alcance del POS**: solo `pickup`, sin delivery. Pago en `cash` o `qr`
(no habrá `card`). El QR hoy es comprobante manual por foto; pronto se
integra una API de banco para QR real — cuando eso pase, el flujo de cobro
por QR va a cambiar y este doc se actualiza.

## 0. Autenticación (dos tokens, nunca en el mismo lugar)

- **Token de servicio del POS** (fijo, uno solo, se configura una vez en la
  app): `Authorization: Bearer <token del api_client "pos">`. Lo usás para
  todo lo que no requiere identificar a una persona (ver menú, crear
  pedido, cambiar estado, confirmar pago).
- **JWT de sesión de staff** (cambia por persona que se loguea, dura 8h):
  se obtiene con `POST /auth/login` y se usa SOLO para las pantallas
  administrativas (mantenimiento de menú, dar de alta staff, aceptar/
  rechazar pedidos fuera de horario). Guardalo en memoria/almacenamiento
  seguro del dispositivo, no en la URL ni en logs.

Todas las requests son JSON (`Content-Type: application/json`), body en
`camelCase` (el backend lo traduce a `snake_case` internamente).

## 1. Pantalla de login (staff)

```
POST /auth/login
{ "username": "...", "password": "..." }
→ 200 { "accessToken": "<jwt>", "user": { "id", "username", "role" } }
```

`role` es `admin` | `kitchen` | `cashier` — usalo para mostrar/ocultar
pantallas administrativas en el POS (por ejemplo, un `cashier` no debería
ver "gestionar menú").

Si cualquier request devuelve **401** con el JWT puesto, es que venció (8h)
— mandá al usuario de vuelta al login. Esto es independiente del token de
servicio del POS, que nunca vence.

## 2. Pantalla principal de venta — armar el catálogo

```
GET /categories   (con el token de servicio)
GET /products
GET /promotions
```

Cada producto trae `isActive` (existe en el menú) e `isAvailable`
(agotado hoy). Mostralos por categoría; ocultá o marcá "agotado"
los que tengan `isAvailable: false`. Las promociones traen `revision` — es
importante guardarlo, se necesita al armar el pedido (ver 4).

## 3. Cliente (opcional)

El POS puede vender sin cliente identificado ("cliente genérico" — no
mandes `customerId` al crear el pedido) o buscarlo/crearlo por teléfono si
quieren llevar historial:

```
POST /customers/find-or-create
{ "phone": "+59171234567", "name": "Juan Pérez" }   // ambos opcionales, pero al menos uno
→ 200/201 { "id": "<customerId>", ... }
```

## 4. Armar y confirmar la venta

```
POST /orders
Idempotency-Key: <uuid nuevo por cada intento de venta>
{
  "customerId": "<opcional>",
  "channel": "pos",
  "customerName": "Juan Pérez",           // obligatorio aunque no haya customerId — usá "Cliente mostrador" si no preguntan
  "deliveryType": "pickup",                // el POS solo vende pickup, no hay delivery desde acá
  "paymentMethod": "cash" | "qr",
  "bypassHoursGate": true,                 // el POS SIEMPRE puede vender fuera del horario de delivery de WhatsApp
  "notes": "sin cebolla",                  // opcional
  "items": [ { "productId": "<uuid>", "quantity": 2 } ],
  "promotions": [ { "promotionId": "<uuid>", "quantity": 1, "revision": 3 } ]  // revision = el que trajo GET /promotions
}
```

**`Idempotency-Key`**: generá un `uuid` nuevo (v4) por cada venta real que
el cajero confirma. Si la request falla por timeout de red y reintentás,
mandá **el mismo** uuid — así nunca se cobra doble el mismo ticket. Si el
cajero cancela y arma una venta nueva desde cero, ahí sí un uuid nuevo.

Respuestas:
- **200/201** — venta creada (o repetida con la misma key: incluso una
  reimpresión de ticket sin re-cobrar).
- **202** — no debería pasar nunca con `bypassHoursGate: true`; si pasa, es
  un bug, avisen.
- **409 `product_unavailable`** / **`promotion_unavailable`** — algo del
  carrito se vendió/desactivó justo antes de confirmar. Mostrá el error y
  refrescá el catálogo (`details` trae qué producto/promo fue).

La respuesta trae el pedido completo con `totalAmount`, `subtotalAmount`,
`items[]` — es lo que imprimís en el ticket.

## 5. Cobro

### Efectivo
```
POST /orders/:id/cash/confirm     → marca payment_status: 'paid'
POST /orders/:id/cash/cancel      → revierte si se equivocaron
```

### QR presencial (cliente paga en el mostrador)
El cliente muestra el QR y paga ahí mismo — no hay foto ni
`payment-proofs` de por medio, un cajero revisa a simple vista y confirma
en el momento. **Requiere login de staff** (rol `cashier` o `admin`, no el
token de servicio del POS):

```
POST /orders/:id/payment-attempts/confirm-presencial
Authorization: Bearer <jwt del cajero logueado>
{ "decision": "accepted" | "rejected" }
```

Si `accepted`, `orders.payment_status` pasa a `paid` en el momento. Si ya
había otro intento vivo para ese pedido (por ejemplo, llegó una foto por
WhatsApp justo antes), da `409 payment_attempt_already_live` — no debería
pasar en el flujo normal de mostrador, pero si pasa, revisen
`GET /orders/:id/payment-attempts` para ver qué hay pendiente.

Esto es provisorio: pronto se integra una API de banco para QR real
(confirmación automática) — cuando esté, este endpoint probablemente deje
de necesitar la revisión manual del cajero. No construyan nada permanente
pensando en que este mecanismo va a durar.

No hay `card` — no es parte del alcance.

## 6. Tablero de pedidos (cocina)

**Requiere login de staff con rol `kitchen` (o `admin`)** — ya no es el
token de servicio del POS. La idea es que cada persona de cocina se loguee
en la pantalla del tablero, así queda registrado quién movió cada pedido.

```
GET /orders?status=confirmed&limit=50&offset=0
Authorization: Bearer <jwt de cocina>
```

Filtros disponibles: `customer_id`, `status`. Para mover un pedido de
estado (ej. cocina marca "listo"):

```
PATCH /orders/:id/status
Authorization: Bearer <jwt de cocina>
{ "to": "preparing" | "ready" | "out_for_delivery" | "delivered" | "cancelled" }
```

Transiciones válidas: `confirmed → preparing → ready → out_for_delivery →
delivered`, o `cancelled` desde casi cualquier punto. Un salto inválido
(ej. `confirmed → delivered` directo) da `409 invalid_state_transition`.
La respuesta del pedido trae `statusUpdatedBy` con el username de quién
hizo el último cambio.

`GET /orders/:id` (un solo pedido, no el listado) sigue con el token de
servicio del POS — eso no cambió, es para imprimir tickets o consultar
estado puntual, no para el tablero.

## 7. Pantallas administrativas (requieren JWT, no el token de servicio)

Todas necesitan `Authorization: Bearer <jwt del login>` y el rol correcto:

| Pantalla | Endpoints | Rol |
|---|---|---|
| Mantenimiento de menú | `POST/PATCH /categories`, `/products`, `/promotions` | `admin` |
| Marcar producto agotado | `PATCH /products/:id/availability` | `admin` o `kitchen` |
| Configuración del local (horario, recargo lluvia, ubicación) | `GET/PATCH /operational-settings` | lectura: token de servicio; escritura: `admin` |
| Alta de staff | `POST/GET /auth/users`, `PATCH /auth/users/:id/active` | `admin` |
| Pedidos fuera de horario (cola) | `GET /late-order-requests`, `POST /:id/accept`, `POST /:id/reject` | `admin` o `cashier` |

## 8. Manejo de errores

Todo error de negocio tiene esta forma, siempre:

```json
{ "code": "product_unavailable", "message": "...", "details": { "...": "..." } }
```

Usá `code` para decidir el comportamiento de la UI (qué pantalla mostrar,
si hay que refrescar el catálogo, etc.); `message` es legible pero no está
pensado como el texto final para el cajero — armá sus propios mensajes por
`code`.

## 9. Para probar mientras desarrollan

Hay una colección de Postman (`postman/backend-central-zarco.postman_collection.json`)
con todos los endpoints y ejemplos ya armados — importala para probar
manualmente antes de cablear cada pantalla.

# Integración del POS con el backend central

Este documento es para quien construya el front del POS. El backend ya
tiene toda la lógica de negocio (menú, pedidos, delivery, pagos) — el POS
es un cliente que solo llama a esta API, no reimplementa nada de eso.

**Alcance del POS**: solo `pickup`, sin delivery. Pago en `cash` o `qr`
(no habrá `card`). El QR hoy es comprobante manual por foto; pronto se
integra una API de banco para QR real — cuando eso pase, el flujo de cobro
por QR va a cambiar y este doc se actualiza.

## 0. Autenticación (un solo token en el POS: el JWT del cajero)

**El POS usa el JWT de sesión de staff para todo.** Se obtiene con
`POST /auth/login`, dura 8h (~un turno) y va en `Authorization: Bearer <jwt>`
en cada request. Guardalo en almacenamiento del dispositivo, nunca en la URL
ni en logs.

No hay un token de servicio embebido en la app. Existe un segundo mecanismo
de auth —un bearer estático por sistema, configurado en la env var
`SERVICE_AUTH_TOKENS` del backend— pero es para llamadas entre backends (el
gateway de WhatsApp). Un token así no vence, y cualquiera que abra las
devtools del navegador podría sacarlo del bundle y crear pedidos: por eso el
POS no lo usa.

En la práctica esto significa que **el POS no funciona sin alguien logueado**.
Si el cajero cierra sesión o el JWT vence, no se puede vender hasta el
siguiente login.

**Si cualquier request devuelve 401**, mandá al usuario de vuelta al login: el
backend usa el mismo mensaje para "token vencido" y "token inválido", así que
no se pueden distinguir. No hay refresh token. Podés decodificar el `exp` del
JWT para avisar antes de que se caiga a mitad de un turno.

Todas las requests son JSON (`Content-Type: application/json`), body en
`camelCase`.

**CORS**: el origen desde el que se sirve el POS tiene que estar en la env var
`CORS_ORIGINS` del backend, o el navegador falla en el preflight antes de
mandar nada.

⚠️ El backend valida con `forbidNonWhitelisted`: **cualquier campo de más en
el body devuelve 400**. No mandes el objeto de estado de React tal cual (con
su `tempId` o lo que sea) — serializá exactamente los campos del contrato.

## 1. Pantalla de login (staff)

```
POST /auth/login
{ "username": "...", "password": "..." }
→ 201 { "accessToken": "<jwt>", "user": { "id", "username", "role" } }
```

`role` es `admin` | `kitchen` | `cashier` — usalo para mostrar/ocultar
pantallas administrativas en el POS (por ejemplo, un `cashier` no debería
ver "gestionar menú"). El backend igual rechaza con 403 lo que el rol no
puede hacer, así que la UI es conveniencia, no seguridad.

## 2. Pantalla principal de venta — armar el catálogo

```
GET /categories
GET /products
GET /promotions
```

Cada producto trae `isActive` (existe en el menú) e `isAvailable`
(agotado hoy). `GET /products` ya filtra los inactivos, así que en la práctica
solo mirás `isAvailable`: mostralos marcados "agotado" en vez de ocultarlos,
para que el cajero entienda por qué no puede venderlos. Los precios vienen
como `number` (formatealos con dos decimales, el backend no lo hace).

⚠️ **`GET /promotions` no filtra nada** — devuelve archivadas, inactivas,
expiradas y programadas mezcladas, a diferencia de `/categories` y
`/products`. Filtrá por `status === 'activa'` en el cliente.

Las promociones traen `revision`: guardalo, se necesita al armar el pedido
(ver 4).

`GET /categories?includeInactive=true` devuelve también las desactivadas —
solo para la pantalla de mantenimiento de menú, no para vender.

## 3. Cliente (opcional)

El POS puede vender sin cliente identificado ("cliente genérico" — no
mandes `customerId` al crear el pedido) o buscarlo/crearlo por teléfono si
quieren llevar historial:

```
POST /customers/find-or-create
{ "phone": "+59171234567", "name": "Juan Pérez" }   // ambos opcionales, pero al menos uno
→ 201 { "id": "<customerId>", ... }
```

Es un find-or-create literal: si el teléfono ya existe con otro nombre,
devuelve el registro existente **sin actualizar el nombre**. Y siempre
responde 201, tanto si creó como si encontró — no se puede distinguir.

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

Límites del carrito: hasta 20 productos sueltos y 10 promociones, `quantity`
entre 1 y 10 por línea, y **sin `productId` ni `promotionId` repetidos** — el
carrito tiene que consolidar líneas iguales. Ojo: más de 10 unidades del mismo
producto no se puede expresar.

**`Idempotency-Key`**: generá un `uuid` v4 **al abrir el carrito**, no en el
clic de confirmar — si lo generás en el clic, un doble clic manda dos keys
distintas y cobra dos veces. Si la request falla por timeout de red y
reintentás, mandá **el mismo** uuid. Descartalo al completarse la venta o al
vaciar el carrito.

⚠️ **No reordenes `items[]` ni `promotions[]` entre reintentos.** La
comparación del body ignora el orden de las claves pero **no el de los
elementos del array**: reordenar con la misma key da un
`409 idempotency_key_reused` espurio. Lo más simple es serializar el body una
sola vez y reusar ese mismo string en el reintento.

Respuestas:
- **201** — venta nueva.
- **200** — respuesta cacheada de la misma key: es una **reimpresión de
  ticket, no un cobro nuevo**. Distinguir 200 de 201 importa.
- **202** — no debería pasar nunca con `bypassHoursGate: true`; si pasa, es
  un bug, avisen.
- **409 `product_unavailable`** / **`promotion_unavailable`** — algo del
  carrito se vendió/desactivó justo antes de confirmar. Mostrá el error y
  refrescá el catálogo (`details` trae qué producto/promo fue).

La respuesta trae el pedido completo — es lo que imprimís en el ticket:

- `items[]` — **solo los productos sueltos**, con los nombres y precios
  congelados al momento de la venta (`productNameSnapshot`,
  `unitPriceSnapshot`).
- `promotions[]` — los combos, cada uno con `promotionNameSnapshot`,
  `promoPriceSnapshot`, `comboQuantity` y `componentsSnapshot[]` (qué
  productos entraron en el combo, para el ticket y para cocina).
- `subtotalAmount` / `totalAmount` — el total autoritativo.

⚠️ `Σ items[].subtotal` **no** cuadra con `subtotalAmount` cuando hay combos:
la diferencia está en `promotions[]`. No valides ese cuadre sumando solo
`items`.

Los totales que calculaste en pantalla son una estimación: el backend
recalcula precios y disponibilidad del lado servidor. Imprimí siempre el
`totalAmount` de la respuesta.

## 5. Cobro

### Efectivo
```
POST /orders/:id/cash/confirm     → marca payment_status: 'paid'
POST /orders/:id/cash/cancel      → revierte si se equivocaron
```

Ambos son idempotentes: llamarlos dos veces es seguro, no cobran doble.
Devuelven el pedido completo actualizado.

### QR presencial (cliente paga en el mostrador)
El cliente muestra el QR y paga ahí mismo — no hay foto ni
`payment-proofs` de por medio, un cajero revisa a simple vista y confirma
en el momento. Requiere rol `cashier` o `admin`:

```
POST /orders/:id/payment-attempts/confirm-presencial
{ "decision": "accepted" | "rejected" }
```

El `:id` es el **id del pedido**, no el del intento de pago.

⚠️ A diferencia de los endpoints de efectivo, este **no devuelve el pedido**
sino `{ attempt, won }`. Si necesitás el pedido actualizado para el ticket,
hacé `GET /orders/:id` después.

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

## 6. Tablero de pedidos (cocina) y cuadre de caja (cuadre con las motos)

**`GET /orders` requiere rol `kitchen`, `cashier` o `admin`.** La idea es
que cada persona se loguee en su pantalla, así queda registrado quién
movió cada pedido.

```
GET /orders?status=confirmed&limit=50&offset=0
```

Filtros: `customer_id`, `status`, `delivery_type`, `payment_status`
(todos **snake_case**, a diferencia del resto de la API), `limit`,
`offset`. Notas del listado:

- Devuelve un **array pelado**: no hay `total` ni `hasMore`. Para saber si hay
  más, pedí `limit + 1` y descartá el extra.
- `limit` se **recorta a 200 en silencio**, sin error.
- Un `status` inválido devuelve `[]` sin avisar — el backend no lo valida.
- Viene ordenado por `created_at desc`. Para cocina probablemente quieras el
  orden inverso (lo más viejo primero).
- No hay websockets: el tablero va por polling (5-10s es razonable).

Para mover un pedido de estado (ej. cocina marca "listo"):

```
PATCH /orders/:id/status
{ "to": "preparing" | "ready" | "out_for_delivery" | "delivered" | "cancelled" }
```

Transiciones válidas: `confirmed → preparing → ready → out_for_delivery →
delivered`, o `cancelled` desde casi cualquier punto. Un salto inválido
(ej. `confirmed → delivered` directo) da `409 invalid_state_transition`.
`delivered` y `cancelled` son terminales: no se sale de ahí, no hay deshacer.
La respuesta del pedido trae `statusUpdatedBy` con el username de quién
hizo el último cambio (solo el último, no hay historial).

⚠️ **No confundas dos errores distintos**: `invalid_state_transition` es un
error del usuario (salto ilegal), pero `409 status_conflict` significa que
otro operario movió el pedido entre que lo leíste y lo mandaste. Con varias
pantallas de cocina abiertas **va a pasar**: refrescá el pedido y mostrá el
estado actual, no un error rojo.

El backend bloquea `confirmed → preparing` con `409 payment_required` si
`paymentStatus` no es `paid` — **excepto** para pedidos de delivery
pagados en efectivo (`deliveryType: 'delivery'` + `paymentMethod: 'cash'`):
ese es el único caso real de pago contra entrega, el repartidor cobra al
llegar, así que ahí `preparing` no exige pago todavía. Como el POS solo
vende `pickup`, esto no te afecta al crear pedidos — sí importa si el
mismo tablero de cocina muestra también pedidos de delivery que vinieron
por WhatsApp: para esos vas a ver `preparing` con `paymentStatus: 'unpaid'`
legítimamente, no lo marques como error.

Para todo lo demás (pickup con cualquier método, o delivery con QR — un
QR no se "entrega") sí hay que confirmar el pago (`cash/confirm` o QR)
antes de mandar a cocina. Las transiciones posteriores
(`preparing → ready → ...`) no vuelven a chequear el pago — si alguien
cancela el efectivo (`cash/cancel`) después de que ya empezó a prepararse,
el pedido sigue avanzando igual; marcalo visualmente si eso pasa.

### Cuadre de fin de noche (pantalla de fase 5)

Como delivery + efectivo entra a `preparing` sin estar pagado, en algún
momento alguien tiene que cerrar esa cuenta con cada repartidor. Es la
misma API, solo otra combinación de filtros y la misma acción de siempre:

```
GET /orders?delivery_type=delivery&payment_status=unpaid
```

Lista los pedidos de delivery todavía sin cobrar (normalmente todos
`paymentMethod: "cash"` — un QR sin pagar ya está atascado antes de
`preparing`, no debería llegar hasta acá). Para ver el detalle de uno,
`GET /orders/:id`. Para marcarlo cobrado cuando el repartidor liquida:

```
POST /orders/:id/cash/confirm
```

Es el mismo endpoint que usa el cobro normal — no hay uno separado para
"cuadre". Es idempotente (llamarlo dos veces no rompe nada) y devuelve el
pedido actualizado con `paymentStatus: "paid"`. No hay endpoint de "marcar
varios a la vez" — es uno por uno.

No hay un concepto de "repartidor" en el backend (no hay tabla de motos ni
se sabe quién entregó cada pedido) — el cuadre es puramente "estos son los
pedidos delivery+efectivo sin cobrar todavía", el humano hace el
emparejamiento con quién salió a repartir qué.

`GET /orders/:id` (un solo pedido, no el listado) es para imprimir tickets o
consultar estado puntual, no para el tablero.

## 7. Pantallas administrativas

Todas necesitan el rol correcto:

| Pantalla | Endpoints | Rol |
|---|---|---|
| Mantenimiento de menú | `POST/PATCH /categories`, `/products`, `/promotions` | `admin` |
| Marcar producto agotado | `PATCH /products/:id/availability` | `admin` o `kitchen` |
| Configuración del local (horario, recargo lluvia, ubicación) | `GET/PATCH /operational-settings` | lectura: cualquiera; escritura: `admin` |
| Alta de staff | `POST/GET /auth/users`, `PATCH /auth/users/:id/active` | `admin` |
| Pedidos fuera de horario (cola) | `GET /late-order-requests`, `POST /:id/accept`, `POST /:id/reject` | `admin` o `cashier` |

Trampas del mantenimiento de menú, todas por `forbidNonWhitelisted`:

- **`isAvailable` no se puede mandar a `PATCH /products/:id`** — da 400, no se
  ignora. La disponibilidad va solo por `PATCH /products/:id/availability`, y
  ahí el campo se llama **`available`**, no `isAvailable`. `code` tampoco es
  editable después de crear el producto.
- **Una promoción nace inactiva**: `POST /promotions` no acepta `isActive`, así
  que hace falta un segundo llamado a `PATCH /promotions/:id/active`. El orden
  se ajusta aparte con `POST /promotions/:id/move`.
- **`items` de una promoción exige 2 elementos distintos**: un combo de "2× el
  mismo producto" es rechazado (la validación cuenta elementos del array, no
  unidades).
- **`code` de producto duplicado** da `409 product_code_taken`.

## 8. Manejo de errores

Todo error de negocio tiene esta forma, siempre:

```json
{ "code": "product_unavailable", "message": "...", "details": { "...": "..." } }
```

Usá `code` para decidir el comportamiento de la UI (qué pantalla mostrar,
si hay que refrescar el catálogo, etc.); `message` es legible pero no está
pensado como el texto final para el cajero — armá sus propios mensajes por
`code`.

Hay dos formas más que no siguen ese molde y conviene normalizar en el cliente
de API antes de que la UI las vea:

- **Errores de validación**: `{ "code": "http_error", "message": [...] }` —
  ahí `message` es un **array de strings**, no un string.
- **Errores no previstos**: `{ "code": "internal_error", ... }` con 500.

Códigos que el POS puede encontrarse:

| `code` | HTTP | Qué hacer |
|---|---|---|
| `product_unavailable` / `promotion_unavailable` | 409 | Marcar el ítem y refrescar el catálogo; `details` dice cuál |
| `idempotency_in_progress` | 409 | **Transitorio**: reintentar con backoff, no mostrarlo como error |
| `idempotency_key_reused` | 409 | Bug del cliente: misma key con distinto body |
| `status_conflict` | 409 | Carrera entre pantallas: refrescar y reintentar |
| `invalid_state_transition` | 409 | Salto de estado ilegal |
| `payment_required` | 409 | Falta confirmar el pago antes de `preparing` (no aplica a delivery+cash, es COD) |
| `payment_attempt_already_live` | 409 | Ya hay un intento de pago vivo para ese pedido |
| `closed` | 409 | No debería pasar con `bypassHoursGate: true` |
| `invalid_credentials` | 401 | Login fallido |
| `not_found` | 404 | `details.resource` dice qué no se encontró |
| `product_code_taken` / `username_taken` | 409 | Duplicado en alta de producto/staff |
| `validation_error` / `http_error` | 400 | Error de formulario |

## 9. Para probar mientras desarrollan

- **Swagger UI** en `/docs` y el OpenAPI crudo en `/docs-json`, generados
  desde el código. Podés generar los tipos de request del cliente con
  `openapi-typescript` contra `/docs-json` en vez de escribirlos a mano.
  (Los tipos de *response* todavía no salen en el OpenAPI — ver README.)
- **Colección de Postman** en `postman/backend-central-zarco.postman_collection.json`,
  con todos los endpoints y ejemplos armados. Ojo: fue escrita cuando el POS
  usaba el token de servicio, así que para los endpoints de venta hay que
  reemplazarlo por un JWT de `POST /auth/login`.

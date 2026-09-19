# Integración del POS con el backend central

Este documento es para quien construya el front del POS. El backend ya
tiene toda la lógica de negocio (menú, pedidos, delivery, pagos) — el POS
es un cliente que solo llama a esta API, no reimplementa nada de eso.

**Alcance del POS**: `pickup` (para llevar desde el mostrador) y `dine_in`
(para comer en el local, mesa), sin delivery. Pago en `cash` o `qr`
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

**Foto de producto**: cada producto trae `imageUrl` — `null` si no tiene
foto, o una ruta relativa (`/products/:id/image`) si tiene. No es una URL
directa al bucket: hay que pedirla con el mismo header `Authorization` que
usás para el resto de la API (el bearer del POS o la sesión del cajero,
cualquiera de los dos sirve). Como `<img src>` no manda headers, en el
navegador hacés `fetch` con el header y armás un `URL.createObjectURL(blob)`
para el `src`; cacheá ese blob en memoria por producto para no repetir el
fetch en cada render.

Las promociones traen `revision`: guardalo, se necesita al armar el pedido
(ver 4).

`GET /categories?includeInactive=true` y `GET /products?includeInactive=true`
devuelven también las desactivadas/os — solo para la pantalla de
mantenimiento de menú (para poder reactivarlas), no para vender.

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
  "deliveryType": "pickup",                // "pickup" = para llevar, "dine_in" = mesa; no hay delivery desde el POS
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

## 5. Apertura y cierre de caja

**Sin caja abierta no se puede cobrar nada** (ni efectivo ni QR) — es la
primera pantalla que necesita el POS antes de vender. Una sola caja abierta
a la vez para todo el local (no por cajero). Requiere rol `cashier` o
`admin`:

```
POST /cash-register/sessions/open
{ "openingAmount": 200 }             // efectivo con el que arranca el turno
→ 201 CashRegisterSession
```

Si ya hay una caja abierta, da `409 cash_register_already_open`. Antes de
mostrar el botón de "abrir caja", conviene chequear si ya hay una:

```
GET /cash-register/sessions/current   → CashRegisterSession & { liveTotals } | null
```

Cualquier rol logueado puede consultar esto (útil para saber si el POS ya
puede vender). Además de la sesión, trae `liveTotals` con cómo va el turno
**hasta este momento**, para mostrar el estado de la caja en pantalla sin
esperar al cierre:

```json
"liveTotals": {
  "totalCashSalesAmount": 840,
  "totalQrSalesAmount": 260,
  "totalSalesAmount": 1100,
  "expectedCashAmount": 1040
}
```

`expectedCashAmount` acá es `openingAmount` + lo cobrado en efectivo hasta
ahora: es lo que debería haber en el cajón si contaras en este instante. Ojo
que los campos del mismo nombre **en la raíz** de la sesión abierta siguen en
`null` — esos son los del arqueo firmado y solo se llenan al cerrar. Usá
`liveTotals` mientras el turno está abierto y los de la raíz una vez cerrado.

Al cerrar el turno:

```
POST /cash-register/sessions/close
{ "countedCashAmount": 950, "notes": "opcional" }   // lo que el cajero contó a mano
→ 200 CashRegisterSession (cerrada, con los totales ya calculados)
```

Si no hay ninguna abierta, da `409 cash_register_not_open`. La respuesta del
cierre trae, todo ya calculado por el backend (nunca lo calcules vos):

- `expectedCashAmount` — `openingAmount` + ventas en efectivo de la sesión.
- `cashDifference` — `countedCashAmount - expectedCashAmount` (negativo = faltó plata).
- `totalCashSalesAmount`, `totalQrSalesAmount`, `totalSalesAmount` — para el
  resumen del turno (efectivo, QR, y el total del día). Solo cuenta lo que
  **ya está pagado** (`paymentStatus: 'paid'`): un pedido tardío en efectivo
  queda vinculado a la caja al aceptarse (sección 8), pero no suma acá hasta
  que alguien haga `cash/confirm` — si se cierra la caja mientras sigue
  `unpaid`, ese pedido simplemente no entra en el total, no se pierde ni
  queda mal contado.

Estos números quedan **congelados en el momento del cierre** — no se
recalculan después aunque algo cambie más tarde. `GET /cash-register/sessions/:id`
(historial, `admin`/`cashier`) devuelve el mismo detalle de una sesión
cerrada, para reimprimir el reporte del cierre.

**Por qué esto bloquea el cobro**: cualquier pedido que se marca pagado (cash
o QR) queda vinculado a la caja abierta en ese instante — es lo que permite
calcular `totalCashSalesAmount`/`totalQrSalesAmount` al cerrar. Si intentás
cobrar sin caja abierta, el endpoint de cobro correspondiente (ver abajo) da
`409 cash_register_closed`: mostrale al cajero que tiene que abrir la caja
primero, no es un error del pedido.

## 6. Cobro

### Efectivo
```
POST /orders/:id/cash/confirm     → marca payment_status: 'paid'
POST /orders/:id/cash/cancel      → revierte si se equivocaron
```

Ambos son idempotentes: llamarlos dos veces es seguro, no cobran doble.
Devuelven el pedido completo actualizado. `cash/confirm` sin caja abierta da
`409 cash_register_closed` (ver sección 5). `cash/cancel` desvincula el
pedido de la caja (si el turno sigue abierto, ya no cuenta para el cierre).

### QR real (Banco Económico)

El cajero genera un QR real del banco para que el cliente lo escanee desde
su propia app bancaria — rol `cashier` o `admin`:

```
POST /orders/:id/qr/generate
→ { "orderId", "status": "pending", "qrImageUrl": "/orders/:id/qr-image", "dueDate" }
```

`qrImageUrl` es una ruta relativa (nunca el Base64 crudo ni una URL directa
del banco) — pedila con el mismo `Authorization: Bearer` de siempre, igual
que la foto de producto. Es **idempotente**: llamarlo dos veces para el
mismo pedido devuelve el mismo QR ya generado, no crea uno nuevo.

La confirmación del pago es **automática**: el backend consulta al banco
cada ~5s (`statusQR`) y en cuanto detecta el pago marca
`orders.payment_status: 'paid'` solo — no hace falta que el POS haga nada
más que esperar (polling de `GET /orders/:id` cada 3-5s mientras el QR está
en pantalla, para que la confirmación se sienta casi instantánea). Sin caja abierta, ni siquiera se puede
generar el QR — mismo `409 cash_register_closed` que el resto de los cobros.

**Fallback manual** — si la confirmación automática tarda o el banco está
caído, el cajero puede confirmar a ojo (vio la notificación de pago en su
propio celular, por ejemplo):

```
POST /orders/:id/payment-attempts/confirm-presencial
{ "decision": "accepted" | "rejected" }
```

El `:id` es el **id del pedido**, no el del intento de pago. Si ya había un
intento vivo (lo normal, dejado por `qr/generate`), decide sobre ese en vez
de crear uno nuevo. ⚠️ A diferencia de los endpoints de efectivo, este **no
devuelve el pedido** sino `{ attempt, won }` — pedí `GET /orders/:id`
después si necesitás el pedido actualizado para el ticket.

No hay `card` — no es parte del alcance.

## 7. Tablero de pedidos (cocina) y cuadre con las motos

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
varios a la vez" — es uno por uno. Igual que cualquier cobro, exige caja
abierta (sección 5): si el repartidor liquida sin que nadie haya abierto la
caja de esa noche, da `409 cash_register_closed`.

⚠️ **No confundir con la caja de la sección 5.** Esto es una consulta ("qué
falta cobrar"), no una sesión — no tiene apertura/cierre propios. El pedido
que se cobra acá sí termina contando en el cierre de caja de la sesión que
esté abierta en ese momento, junto con todo lo demás.

No hay un concepto de "repartidor" en el backend (no hay tabla de motos ni
se sabe quién entregó cada pedido) — el cuadre es puramente "estos son los
pedidos delivery+efectivo sin cobrar todavía", el humano hace el
emparejamiento con quién salió a repartir qué.

`GET /orders/:id` (un solo pedido, no el listado) es para imprimir tickets o
consultar estado puntual, no para el tablero.

## 8. Pantallas administrativas

Todas necesitan el rol correcto:

| Pantalla | Endpoints | Rol |
|---|---|---|
| Mantenimiento de menú | `POST/PATCH /categories`, `/products`, `/promotions` | `admin` |
| Foto de producto | `POST /products/:id/image` (ver abajo) | `admin` |
| Marcar producto agotado | `PATCH /products/:id/availability` | `admin` o `kitchen` |
| Configuración del local (horario, recargo lluvia, ubicación) | `GET/PATCH /operational-settings` | lectura: cualquiera; escritura: `admin` |
| Alta de staff | `POST/GET /auth/users`, `PATCH /auth/users/:id/active` | `admin` |
| Pedidos fuera de horario (cola) | `GET /late-order-requests`, `POST /:id/accept`, `POST /:id/reject` | `admin` o `cashier` |
| Apertura/cierre de caja | `POST /cash-register/sessions/open`, `/close` | `admin` o `cashier` |
| Pagos QR cobrados sin aplicar (ver abajo) | `GET /bank-qr/unapplied-payments`, `POST /:id/apply`, `POST /:id/refunded` | `admin` o `cashier` (`refunded`: solo `admin`) |

**Pagos QR cobrados sin aplicar.** Un cliente puede pagar el QR justo
después de que cerraron la caja. La plata entra al banco igual, pero el
backend no puede aplicarla a ningún turno, así que el cobro queda apartado y
llega una alerta a Telegram. Esta pantalla es la que resuelve esos casos:

```
GET /bank-qr/unapplied-payments
→ 200 [ { id, orderId, orderNumber, customerName, customerPhone, amount, paidDetectedAt, orderPaymentStatus } ]
```

Viene el teléfono del cliente justamente para poder escribirle. Dos salidas,
y las dos las decide una persona:

- `POST /bank-qr/unapplied-payments/:id/apply` → 204. El local sigue abierto:
  se aplica el pago al pedido y el pedido pasa a pagado. **Exige caja
  abierta** como cualquier cobro (si no hay, `409 cash_register_closed`).
- `POST /bank-qr/unapplied-payments/:id/refunded` → 204, body
  `{ "notes": "devuelto por transferencia" }` (opcional). Solo deja registro
  de que ya se le devolvió la plata al cliente: **el banco no tiene API de
  devolución**, así que devolver es siempre a mano y esto solo lo saca de la
  cola. El pedido no se toca — si hay que cancelarlo, va por
  `PATCH /orders/:id/status`.

Si el cobro ya no está pendiente de decisión (otro lo resolvió antes), las
dos devuelven `409 charge_not_unapplied`.

`POST /late-order-requests/:id/accept` exige caja abierta (sección 5) — es
el momento en que un pedido fuera de horario entra oficialmente al turno,
sea cash o QR. Sin caja abierta da `409 cash_register_closed` **sin tocar la
solicitud**: sigue `pending`, reintentá apenas alguien abra la caja. `reject`
no la necesita (no hay plata de por medio).

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

**Subir foto de producto**:

```
POST /products/:id/image
{ "mimeType": "image/jpeg" | "image/png" | "image/webp", "fileBase64": "<bytes en base64>" }
→ 200 ProductResponse (con imageUrl ya seteado)
```

Máximo 5 MB. Subir una foto nueva **reemplaza** la anterior (no hace falta
borrar antes). No hay endpoint para borrar la foto — para "sacarla" hoy
subís cualquier imagen en blanco; si hace falta un borrado real, pedilo y lo
agregamos.
- **`code` de producto duplicado** da `409 product_code_taken`.

## 9. Manejo de errores

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
| `cash_register_closed` | 409 | No hay caja abierta — mandá a abrir caja, no es error del pedido |
| `cash_register_already_open` | 409 | Ya hay una caja abierta (al intentar abrir otra) |
| `cash_register_not_open` | 409 | No hay caja abierta para cerrar |
| `closed` | 409 | No debería pasar con `bypassHoursGate: true` |
| `invalid_credentials` | 401 | Login fallido |
| `not_found` | 404 | `details.resource` dice qué no se encontró |
| `product_code_taken` / `username_taken` | 409 | Duplicado en alta de producto/staff |
| `validation_error` / `http_error` | 400 | Error de formulario |

## 10. Para probar mientras desarrollan

- **Swagger UI** en `/docs` y el OpenAPI crudo en `/docs-json`, generados
  desde el código. Podés generar los tipos de request del cliente con
  `openapi-typescript` contra `/docs-json` en vez de escribirlos a mano.
  (Los tipos de *response* todavía no salen en el OpenAPI — ver README.)
- **Colección de Postman** en `postman/backend-central-zarco.postman_collection.json`,
  con todos los endpoints y ejemplos armados. Ojo: fue escrita cuando el POS
  usaba el token de servicio, así que para los endpoints de venta hay que
  reemplazarlo por un JWT de `POST /auth/login`.

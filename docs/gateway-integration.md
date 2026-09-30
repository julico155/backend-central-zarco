# Integración con el agente de WhatsApp

Este documento es para quien implemente el agente de WhatsApp (`saas_smarky`
o su reemplazo). El backend central ya tiene toda la lógica de negocio
(pedidos, pagos, delivery, promociones) — el agente **no debe reimplementar
nada de eso**, solo:

1. Recibir mensajes de WhatsApp y traducirlos a llamadas HTTP hacia este
   backend (dirección **agente → backend**, sección 2).
2. Exponer 3 endpoints propios para que este backend le pida enviar
   mensajes salientes (dirección **backend → agente**, sección 3).

## 0. Autenticación

Dos bearer tokens completamente independientes, nunca en el mismo header:

- **Agente → backend**: `Authorization: Bearer <SERVICE_AUTH_TOKENS del api_client "whatsapp-gateway">`. Te lo pasamos aparte (no va en este doc ni en el repo).
- **Backend → agente**: el backend manda `Authorization: Bearer <GATEWAY_AUTH_TOKEN>` en cada llamada a tus endpoints. Debes validar ese valor exacto — también te lo pasamos aparte.

Todas las llamadas en ambas direcciones son JSON (`Content-Type: application/json`).

## 1. Base URL

`https://<a-confirmar-tras-el-deploy-en-railway>`

## 2. Lo que el agente llama hacia el backend

### 2.1 Resolver/crear cliente

```
POST /customers/find-or-create
{ "phone": "+59171234567", "name": "Juan Pérez" }
→ 200/201 { "id": "<customerId>", "name": "...", "phone": "...", "email": null }
```

Guarda ese `customerId` — lo necesitas para todo lo demás.

### 2.2 Consultar menú (para armar el catálogo que le muestras al cliente)

```
GET /categories
GET /products
GET /promotions
```

Cada producto trae `imageUrl` — `null` si no tiene foto, o una ruta relativa
(`/products/:id/image`) si tiene. Para mandarla por WhatsApp: pedila con
`GET <baseUrl><imageUrl>` con tu mismo bearer de servicio, y subí los bytes
que te devuelve a la Media API de WhatsApp (no es una URL pública que
puedas pasarle directo a Meta).

Cada producto también trae `complements[]` (ej. tomate, lechuga, cebolla,
quirquiña) — ingredientes que el cliente puede pedir sacar. Por defecto van
TODOS incluidos; si el cliente dice "sin quirquiña", usalo en el `item`
correspondiente al armar el pedido (ver 2.3). Un producto sin complementos
configurados trae `complements: []` — no le preguntes nada al cliente en
ese caso.

### 2.3 Crear pedido

```
POST /orders
Idempotency-Key: <uuid único por intento — SIEMPRE, ver nota abajo>
{
  "customerId": "<customerId>",
  "channel": "whatsapp",             // opcional: el canal se deriva de tu token (whatsapp-gateway = whatsapp); si lo mandás y no coincide, 400 channel_mismatch
  "customerName": "Juan Pérez",
  "deliveryType": "delivery" | "pickup" | "dine_in",   // pickup = para llevar, dine_in = comer en el local
  "paymentMethod": "qr",                 // WhatsApp solo acepta qr; cualquier otro método da 400 payment_method_not_allowed
  "notes": "sin cebolla" ,           // opcional
  "items": [
    { "productId": "<uuid>", "quantity": 3 },
    { "productId": "<uuid>", "quantity": 1, "excludedComplements": ["quirquiña"] }
  ],
  "promotions": [ { "promotionId": "<uuid>", "quantity": 1, "revision": 3 } ] // opcional; revision = el que te devolvió GET /promotions
}
```

**`excludedComplements`** (opcional, por línea): si el cliente pide "3
trancapechos, uno sin quirquiña", eso son **dos líneas del mismo
`productId`** — no se puede mezclar en una sola porque cada unidad puede
llevar una selección distinta. Mandar un nombre que el producto no tiene en
su `complements[]` (ver 2.2) da `400 unknown_complement`. Repetir la misma
combinación producto+exclusión en dos líneas da `400 validation_error` —
sumá la cantidad en una sola línea.

Respuestas posibles:
- **200/201** — pedido creado. `200` si repetiste la misma `Idempotency-Key` con el mismo cuerpo (no se duplicó, te devuelve el mismo pedido de antes).
- **202** — el pedido queda pendiente de que un humano lo acepte (`late_order_request`). Pasa cada vez que no hay staff con la caja abierta en ese momento — puede ser tarde en la noche, pero también temprano si todavía no abrieron, o si cerraron antes de lo habitual esa noche en particular (el horario real varía). Avísale al cliente que su pedido está "en revisión", nunca que está confirmado — vence solo a los 10 minutos si nadie lo revisa.
- **409 `closed`** — fuera de cualquier horario plausible del local (ej. de madrugada/mañana), no se puede pedir.
- **409 `product_unavailable`** / **`promotion_unavailable`** — algo del carrito ya no está disponible; el `details` trae qué producto/promo fue.

**Sobre `Idempotency-Key`**: generá un UUID nuevo por cada intento REAL del usuario de confirmar su pedido, y **reusá el mismo UUID** si estás reintentando la misma request por un timeout/error de red — así nunca se duplica el pedido. No generes uno nuevo en cada reintento automático.

### 2.4 Delivery: pedir y adjuntar ubicación

Al crear un pedido de delivery, apenas queda en `awaiting_location` el
backend manda **una sola** solicitud (`location_request`, sección 3.2) —
**no hace falta que el agente lo pida**. Central solo entrega los datos
(`reason` + `orderNumber`); el copy final (incluido el "recibimos tu
pedido") lo arma el agente — ver sección 3.2 para el texto canónico
esperado. Pickup y mesa sí reciben `order_received` (sección 3.1) porque no
esperan ubicación. Un reintento de creación con el mismo `Idempotency-Key`
no vuelve a mandar nada (solo pasa en la creación real).

```
POST /orders/:id/location-request     // reenvío manual, por si hace falta pedirla de nuevo
POST /orders/:id/location
{ "latitude": -16.5, "longitude": -68.15 }
```

Adjuntar la ubicación dispara la cotización automáticamente (distancia real
por calle, tarifa, recargo por lluvia si aplica). La respuesta trae el
pedido actualizado con `totalAmount` ya con el delivery incluido.

⚠️ **`totalAmount` NO es lo que se cobra por QR.** Con `paymentMethod: "qr"`
el QR **siempre cobra solo la comida** (`subtotalAmount`) — nunca hay pago
contra entrega de la comida, pero el envío sí sigue siendo cobro contra
entrega: el repartidor lo cobra en efectivo al llegar. Cuando le confirmés
el total al cliente, decile los dos montos por separado y aclarale ese
punto — por ejemplo: *"Tu pedido de comida es Bs {subtotalAmount} (ya
pagado por QR) + Bs {deliveryBaseAmount + deliverySurchargeAmount} de envío,
que le pagás al repartidor al recibir."* Si le decís un solo número
(`totalAmount`) sin aclarar, va a esperar que el QR cubra todo y se va a
confundir cuando el repartidor le pida el envío en efectivo.

#### Ubicación por teléfono (sin conocer el `orderId`)

```
POST /internal/agent/locations/attach        // solo token whatsapp-gateway
{ "customerPhone": "59170001234", "latitude": -17.78, "longitude": -63.18,
  "sourceMessageId": "wamid..." }
→ 200 { "result": ..., ... }
```

Central resuelve cliente (teléfono normalizado a `+<dígitos>`, nunca asume
país) y pedido; el agente no consulta pedidos ni calcula delivery. Siempre
responde 200 con `result`:

| `result` | Cuándo | Extra |
|---|---|---|
| `attached` | 1 pedido delivery esperando ubicación (`awaiting_location`, dentro del TTL de 10 min): se guarda y se cotiza | `orderId`, `orderNumber`, `quote` |
| `already_attached` | el pedido que espera ubicación ya tiene esa misma ubicación (tolerancia ~5 m) | `orderId`, `orderNumber` |
| `location_conflict` | el pedido que espera ubicación está en `pending_manual` y llega una ubicación distinta: **no se modifica nada** | `orders[]` |
| `ambiguous_order` | 2 o más pedidos esperando ubicación: no elige ninguno | `orders[]` (`id`, `orderNumber`, `totalAmount`) |
| `no_order` | no hay cliente o ningún pedido esperando ubicación y vigente. Vencidos, cancelados y pedidos ya cotizados/en curso **no cuentan** (no se miran): es la señal para pasar a `POST /delivery/quotes` | — |

Una ubicación distinta con el pedido todavía sin cotizar (`pending`/`failed`)
reemplaza la anterior y cotiza (`attached`). `sourceMessageId` deduplica
reintentos: el mismo `wamid` con el mismo cuerpo devuelve la misma respuesta;
con otro cuerpo, `409 idempotency_key_reused`. `POST /orders/:id/location`
aplica la misma protección (`409 location_conflict`).

#### Cotizar sin pedido

```
POST /delivery/quotes        // Idempotency-Key obligatorio
{ "latitude": -17.78, "longitude": -63.18 }
→ { "status": "quoted", "distanceMeters": 4200, "feeAmount": 15,
    "surchargeAmount": 3, "totalAmount": 18 }
```

`totalAmount` = tarifa + recargo por lluvia vigente (el monto real). No crea
pedido ni guarda la ubicación para uno futuro: al crear el pedido hay que
pedir/adjuntar una ubicación nueva. `status: "manual_quote"` = fuera del
rango automático (montos `null`).

### 2.5 Pago QR

**Reglas de pago de WhatsApp**: todos los pedidos (delivery, pickup y mesa)
se pagan **solo por QR** — no hay efectivo ni tarjeta por este canal. Un
pedido que no se paga en **10 minutos** se cancela solo (se anula su QR en el
banco y le llega al cliente un mensaje saliente normal avisándole que el
pedido fue cancelado y que puede hacer uno nuevo). Además, el token del
agente ya **no** puede confirmar ni cancelar cobros en efectivo
(`cash/confirm` y `cash/cancel` son solo para staff).

Para pedidos con `paymentMethod: "qr"`, el backend genera un QR real del
banco y te manda solo una intención `messageType: "qr_confirmation"` (ver
sección 3.1 para el `context` completo, con el desglose de productos,
subtotal y envío) — no hace falta que el agente pida nada. **El momento en
que se manda depende del tipo de pedido**: pickup y mesa no esperan nada
más, así que el QR sale apenas se crea el pedido. Delivery todavía no tiene
el total final (falta el envío, que se calcula recién con la ubicación) —
el QR sale recién cuando el pedido pasa de `awaiting_location` a
`confirmed` con la cotización aplicada, es decir tras
`POST /internal/agent/locations/attach` (sección 2.3) con resultado
`attached` y cotización `applied`. Si la ubicación cae `pending_manual`
(fuera del techo automático), el QR espera a que un `admin`/`cashier` fije
el monto a mano; ahí también se manda solo. La confirmación del pago es
automática (el backend consulta al banco solo); cuando se confirma, el
agente recibe `messageType: "payment_confirmed"` (sección 3.1).

Si por algún motivo el banco falla al generar el QR, el backend manda
`messageType: "payment_proof_request"` en vez del QR — el agente le pide al
cliente que pague y mande la captura (mismo mecanismo de `payment-proofs`
de abajo). El monto a comprobar en la foto (`context.qrAmount`) también es
solo la comida, nunca el envío.

#### Comprobante de pago (fallback si el cliente paga por fuera y manda foto igual)

Cuando el cliente manda la foto del comprobante:

```
POST /payment-proofs
{
  "customerId": "<customerId>",
  "sourceMessageId": "<id del mensaje de WhatsApp de la foto — único, es la barrera de idempotencia>",
  "contextMessageId": "<id del mensaje AL QUE el cliente respondió, si fue una respuesta directa — si no, omitir>",
  "mimeType": "image/jpeg",
  "fileBase64": "<contenido del archivo en base64>"
}
```

El backend decide solo a qué pedido pertenece (por respuesta directa al
mensaje del QR, o único pedido QR abierto reciente del cliente). Si no
puede decidir, responde `422 payment_proof_no_match` o `409` con
`routingException` — en esos casos, avisale al cliente que un humano va a
revisar el pago manualmente (ya le llega la alerta al staff, no hace falta
que el agente haga nada más).

### 2.6 Consultar estado de un pedido (opcional, para polling)

```
GET /orders/:id
```

## 3. Lo que el agente debe exponer (el backend te llama a vos)

Estos 3 endpoints son responsabilidad del agente. El backend reintenta
automáticamente con backoff si fallan (hasta 8 intentos), así que
devolver un error HTTP ante un fallo real (en vez de colgarse) es correcto.

### 3.1 Enviar mensaje de WhatsApp

**Central nunca manda texto customer-facing.** Todo lo que llega por
`POST /gateway/whatsapp/messages` es una intención estructurada:
`{ customerId, messageType, context, imageUrl? }`. El agente decide copy,
emojis, formato y CTA — Central solo entrega los datos.

```
POST /gateway/whatsapp/messages
{ "customerId": "<uuid>", "messageType": "qr_confirmation",
  "imageUrl": "...", "context": { ... } }
→ 200 { "externalMessageId": "<id del mensaje que devuelve la API de WhatsApp>" }
```

`externalMessageId` es importante: el backend lo guarda y lo usa después
para reconocer cuándo un cliente **responde directamente** a ese mensaje
(por ejemplo, para asociar un comprobante al pedido correcto sin
ambigüedad). Si tu proveedor de WhatsApp no te da un id de mensaje,
devolvé cualquier string único y estable para ese envío.

`messageType` y su `context`:

| `messageType` | Cuándo | `context` |
|---|---|---|
| `order_received` | Pickup/mesa al crear el pedido (delivery no lo recibe, ver `location_request`) | `{ orderNumber, deliveryType }` |
| `qr_confirmation` | QR real generado con éxito (pickup/mesa al crear; delivery recién tras cotizar) | `{ orderNumber, currency: "BOB", deliveryType, items[], promotions[], subtotalAmount, deliveryBaseAmount, deliverySurchargeAmount, deliveryAmount, totalAmount, qrAmount }` + `imageUrl` |
| `payment_proof_request` | El banco falló al generar el QR real: fallback, se pide pagar y mandar captura | `{ orderNumber, qrAmount }` |
| `payment_confirmed` | Pago aceptado (QR o efectivo). `fullyPaid: false` solo en un `split` cuando la pata QR entró pero la pata efectivo todavía no | `{ orderNumber, deliveryType, fullyPaid }` |
| `payment_rejected` | El comprobante/pago fue rechazado | `{ orderNumber, deliveryType }` |
| `order_expired_unpaid` | El pedido se cancela solo por no pagarse en el TTL (10 min) | `{ orderNumber }` |
| `late_request_unavailable` | Solicitud fuera de horario aceptada por staff, pero el carrito ya no está disponible (producto/promo caídos) | `{ requestNumber }` |
| `late_request_accepted` | Solicitud fuera de horario aceptada, pedido creado | `{ requestNumber, orderId }` |
| `late_request_rejected` | Solicitud fuera de horario rechazada por staff | `{ requestNumber }` |

**`qr_confirmation.context` en detalle** — Central calcula y entrega todos
los montos, el agente no recalcula nada:

```
{
  "orderNumber": "ORD-260929-007",
  "currency": "BOB",
  "deliveryType": "delivery",
  "items": [
    { "name": "Trancapecho", "quantity": 1, "unitPrice": 18, "subtotal": 18, "excludedComplements": [] },
    { "name": "Limonada", "quantity": 1, "unitPrice": 4, "subtotal": 4, "excludedComplements": [] }
  ],
  "promotions": [
    { "name": "Combo Trancapecho", "quantity": 1, "unitPrice": 20, "subtotal": 20,
      "components": [{ "name": "Trancapecho", "quantity": 1 }, { "name": "Gaseosa", "quantity": 1 }] }
  ],
  "subtotalAmount": 22,
  "deliveryBaseAmount": 8,
  "deliverySurchargeAmount": 2,
  "deliveryAmount": 10,
  "totalAmount": 32,
  "qrAmount": 22
}
```

`qrAmount` es siempre `subtotalAmount` — **el monto autoritativo que cobra
ESTE QR**, nunca incluye envío. Para pickup/mesa, `deliveryAmount` es `0` y
`totalAmount === subtotalAmount === qrAmount` (no hay envío que cobrar
aparte). Para delivery, mostrale al cliente el desglose completo: el envío
se paga en efectivo al repartidor al momento de la entrega, nunca por QR —
si solo le mostrás `qrAmount`/`totalAmount` sin aclarar, va a esperar que
el QR cubra todo y se va a confundir cuando el repartidor le pida el envío.

### 3.2 Pedir ubicación al cliente

```
POST /gateway/whatsapp/location-requests
{ "customerId": "<uuid>", "reason": "delivery_location", "orderNumber": "ORD-260929-007" }
→ 204 (sin body)
```

`orderNumber` es nuevo y opcional (compatibilidad hacia atrás: una llamada
vieja sin `orderNumber` sigue siendo válida). Con `orderNumber`, armá el
mensaje canónico — mostrando el pedido corto (`ORD-AAMMDD-NNN` → `#N`; los
formatos legacy se muestran completos):

```
📦 Recibimos tu pedido #7.

📍 Ahora envíanos tu *UBICACIÓN ACTUAL* por GPS para calcular el costo del envío 😊
Pedido ORD-260929-007

Toca el clip 📎 → Ubicación → ENVIAR UBICACIÓN ACTUAL
```

Sin `orderNumber` (llamada legacy), el fallback:

```
Por favor comparte tu ubicación actual para coordinar el delivery.

Toca el clip 📎 → Ubicación → ENVIAR UBICACIÓN ACTUAL
```

### 3.3 Alerta a Telegram (grupo de staff)

```
POST /gateway/telegram/alerts
{
  "chatRef": "staff-group",
  "text": "Solicitud fuera de horario SOL-000045 — Juan Pérez, total 45.00.",
  "editMessageId": "<opcional — si viene, editá el mensaje existente en vez de mandar uno nuevo>",
  "buttons": [
    { "label": "Aceptar", "action": "late-order-requests/<id>/accept" },
    { "label": "Rechazar", "action": "late-order-requests/<id>/reject" }
  ]
}
→ 200 { "externalMessageId": "<id del mensaje de Telegram>" }
```

Los botones son solo texto/acción para que vos armes el teclado inline de
Telegram — el backend no sabe nada de la UI de Telegram, solo te pasa
label+action.

## 4. Errores

Todos los errores de este backend tienen esta forma (nunca texto crudo de
Postgres ni stack traces):

```json
{ "code": "product_unavailable", "message": "...", "details": { "...": "..." } }
```

Usá `code` para decidir programáticamente qué decirle al cliente; `message`
es para vos (debug), no está pensado para mostrárselo tal cual al usuario final.

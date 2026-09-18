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

### 2.3 Crear pedido

```
POST /orders
Idempotency-Key: <uuid único por intento — SIEMPRE, ver nota abajo>
{
  "customerId": "<customerId>",
  "channel": "whatsapp",
  "customerName": "Juan Pérez",
  "deliveryType": "delivery" | "pickup" | "dine_in",   // pickup = para llevar, dine_in = comer en el local
  "paymentMethod": "qr" | "cash" | "card",
  "notes": "sin cebolla" ,           // opcional
  "items": [ { "productId": "<uuid>", "quantity": 2 } ],
  "promotions": [ { "promotionId": "<uuid>", "quantity": 1, "revision": 3 } ] // opcional; revision = el que te devolvió GET /promotions
}
```

Respuestas posibles:
- **200/201** — pedido creado. `200` si repetiste la misma `Idempotency-Key` con el mismo cuerpo (no se duplicó, te devuelve el mismo pedido de antes).
- **202** — el pedido queda pendiente de que un humano lo acepte (`late_order_request`). Pasa cada vez que no hay staff con la caja abierta en ese momento — puede ser tarde en la noche, pero también temprano si todavía no abrieron, o si cerraron antes de lo habitual esa noche en particular (el horario real varía). Avísale al cliente que su pedido está "en revisión", nunca que está confirmado — vence solo a los 10 minutos si nadie lo revisa.
- **409 `closed`** — fuera de cualquier horario plausible del local (ej. de madrugada/mañana), no se puede pedir.
- **409 `product_unavailable`** / **`promotion_unavailable`** — algo del carrito ya no está disponible; el `details` trae qué producto/promo fue.

**Sobre `Idempotency-Key`**: generá un UUID nuevo por cada intento REAL del usuario de confirmar su pedido, y **reusá el mismo UUID** si estás reintentando la misma request por un timeout/error de red — así nunca se duplica el pedido. No generes uno nuevo en cada reintento automático.

### 2.4 Delivery: pedir y adjuntar ubicación

```
POST /orders/:id/location-request     // le pide la ubicación al cliente (dispara aviso de WhatsApp)
POST /orders/:id/location
{ "latitude": -16.5, "longitude": -68.15 }
```

Adjuntar la ubicación dispara la cotización automáticamente (distancia real
por calle, tarifa, recargo por lluvia si aplica). La respuesta trae el
pedido actualizado con `totalAmount` ya con el delivery incluido — ahí es
cuando le confirmás el total final al cliente.

### 2.5 Pago QR

Para pedidos con `paymentMethod: "qr"`, el backend genera un QR real del
banco apenas se crea el pedido y te lo manda solo, como un mensaje normal
(`POST /gateway/whatsapp/messages` con `imageUrl`) — no hace falta que el
agente pida nada. La confirmación del pago también es automática (el
backend consulta al banco solo); cuando se confirma, el agente recibe otro
mensaje saliente normal avisándole al cliente.

Si por algún motivo el banco falla al generar el QR, el backend cae a pedir
la captura como antes (mismo mecanismo de `payment-proofs` de abajo) — el
agente no necesita distinguir un caso del otro, ambos llegan como mensajes
salientes normales.

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

```
POST /gateway/whatsapp/messages
{ "customerId": "<uuid>", "text": "Recibimos tu pedido ORD-000123.", "imageUrl": "..." }  // imageUrl opcional
→ 200 { "externalMessageId": "<id del mensaje que devuelve la API de WhatsApp>" }
```

`externalMessageId` es importante: el backend lo guarda y lo usa después
para reconocer cuándo un cliente **responde directamente** a ese mensaje
(por ejemplo, para asociar un comprobante al pedido correcto sin
ambigüedad). Si tu proveedor de WhatsApp no te da un id de mensaje,
devolvé cualquier string único y estable para ese envío.

### 3.2 Pedir ubicación al cliente

```
POST /gateway/whatsapp/location-requests
{ "customerId": "<uuid>", "reason": "delivery_location" }
→ 204 (sin body)
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

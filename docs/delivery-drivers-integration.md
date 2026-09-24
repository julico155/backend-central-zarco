# Repartidores (rol `delivery`)

Pantalla del repartidor: ve los pedidos de delivery que cocina dejó `ready`,
acepta los que va a llevar **estando en el local**, ve el detalle completo del
cliente y al final marca **entregado**. Un repartidor puede llevar varios
pedidos a la vez.

Todos los endpoints requieren `Authorization: Bearer <jwt>` de un usuario con
rol `delivery` (o `admin` como override). El rol `delivery` **no** tiene acceso
a nada más: clientes, pedidos, catálogo, caja y reportes le dan `403`.

Crear un repartidor (lo hace un admin): `POST /auth/users` con
`{ "username": "...", "password": "...", "role": "delivery" }`.

## Flujo

```
cocina: ... → ready
repartidor: GET available → POST accept (en el local) → out_for_delivery
repartidor: GET mine (detalle) → POST deliver → delivered
```

`PATCH /orders/:id/status` ya no permite a cocina mover un pedido de delivery a
`out_for_delivery` ni `delivered` (`403 delivery_flow_only`); solo el repartidor
o un admin. Pickup y mesa no cambian.

## Endpoints

### `GET /delivery/orders/available`
Pedidos `ready`, de delivery y sin repartidor, más viejos primero. **Solo
resumen**, sin datos del cliente hasta aceptar:

```json
[{ "id": "...", "orderNumber": "ORD-0123", "itemsCount": 3,
   "deliveryDistanceMeters": 2100, "deliveryFeeAmount": 15,
   "readySince": "2026-09-23T18:04:00.000Z",
   "nearbyOrders": [{ "id": "...", "orderNumber": "ORD-0124", "distanceMeters": 180 }] }]
```

`deliveryFeeAmount` es solo informativo: el envío se le paga al repartidor y no
se cuadra en el sistema (la comida siempre se cobra antes, por QR).

`nearbyOrders`: otros pedidos disponibles a menos de
`DELIVERY_NEARBY_RADIUS_METERS` (default 500 m) de este — para que el
repartidor detecte dos pedidos que le convenga llevarse en un solo viaje.
**Nunca es la ubicación del cliente**: solo la distancia entre pedidos entre
sí. La lat/lng real de cada pedido sigue oculta hasta aceptarlo (ahí sí,
`mine` trae `latitude`/`longitude`/`mapsUrl`) — mostrale al repartidor algo
como "a 180m de ORD-0124" o un link "¿Llevar los dos?", nunca coordenadas.
Un pedido sin cotización de distancia todavía (`deliveryQuoteStatus` distinto
de `quoted`) puede no tener con qué agruparse y trae `nearbyOrders: []`.

### `POST /delivery/orders/:id/accept`
```json
{ "latitude": -17.39, "longitude": -66.16, "accuracyMeters": 12 }
```
`accuracyMeters` (opcional) es `coords.accuracy` del navegador. Verifica que el
celular esté a menos de `DELIVERY_ACCEPT_RADIUS_METERS` (default 150 m) de las
coordenadas del local (`operational-settings`), y asigna el pedido con un CAS:
si dos repartidores aceptan a la vez, gana uno. Devuelve el detalle completo
(igual que un ítem de `mine`). Errores:

| Código | HTTP | Cuándo |
|---|---|---|
| `not_at_restaurant` | 403 | Fuera del radio (`details.distanceMeters`) |
| `location_too_imprecise` | 400 | `accuracyMeters` peor que el radio |
| `restaurant_location_not_configured` | 409 | El local no tiene coordenadas cargadas |
| `order_already_taken` | 409 | Otro repartidor lo aceptó primero |
| `order_not_ready` | 409 | No es un delivery `ready` |

### `GET /delivery/orders/mine`
Mis pedidos en reparto (`out_for_delivery`), con el detalle completo:
`customerName`, `customerPhone`, `latitude`/`longitude`, `mapsUrl` (link a
Google Maps), `notes`, `items[]` (con `excludedComplements`), `promotions[]`,
`deliveryFeeAmount`, `acceptedAt`.

### `POST /delivery/orders/:id/deliver`
Solo el repartidor asignado (o admin). `out_for_delivery → delivered`; devuelve
`{ id, deliveredAt }`. Errores: `not_your_order` (403),
`order_not_out_for_delivery` (409).

### `GET /delivery/orders/history`
Entregas ya hechas, más nuevas primero. Roles `delivery`, `admin` y `cashier`.

| Query | Qué hace |
|---|---|
| `from`, `to` | Fechas `YYYY-MM-DD` de Bolivia, inclusivas, sobre `deliveredAt`. **Sin ninguna, devuelve las de hoy.** Máximo 366 días. |
| `driver_id` | Solo `admin`/`cashier`: filtra por un repartidor; sin él ven todos. Un `delivery` que pida otro id recibe `403 not_your_history`; sin él ve solo las suyas. |
| `limit`, `offset` | Paginación (default 50, tope 200). |

```json
{ "totals": { "deliveries": 7, "deliveryFeeTotal": 105 },
  "limit": 50, "offset": 0,
  "orders": [{ "id": "...", "orderNumber": "ORD-0123", "customerName": "Ana",
    "driverId": "...", "driverName": "moto1",
    "acceptedAt": "2026-09-23T22:10:00.000Z", "deliveredAt": "2026-09-23T22:32:00.000Z",
    "deliveryDistanceMeters": 2100, "deliveryFeeAmount": 15 }] }
```

`totals` cubre el filtro completo, no solo la página. Los minutos en ruta salen
de `deliveredAt - acceptedAt`. `deliveryFeeTotal` es informativo ("cuánto le
corresponde"): el envío no se cuadra en el sistema.

## Límites conocidos

- La verificación de presencia usa el GPS que manda el celular: corta el
  "aceptar de lejos" casual, pero un GPS falseado técnicamente puede engañarla.
- El pedido guarda solo el **pin** de ubicación del cliente, no una dirección
  escrita: el repartidor ve el pin, el link de Maps, el teléfono y las notas.
- No hay "soltar" un pedido ya aceptado: si el repartidor no puede llevarlo, un
  admin lo resuelve (cancelar o reasignar a mano).
- `OrderResponse` y el detalle de reportería exponen `deliveryDriverName`,
  `deliveryAcceptedAt` y `deliveredAt`.

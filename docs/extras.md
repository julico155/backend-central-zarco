# Extras (carne, queso, huevo…)

Agregados **con precio** que se suman a una línea de producto. Distintos de los *complementos* (`product_complements`),
que solo se pueden quitar y no tienen precio.

## Modelo

- `extras`: `name`, `price`, `applies_to_all`, `is_active`, `sort_order`.
- `extra_products`: a qué productos aplica cuando `applies_to_all = false`. La carne del trancapecho no es la de los
  mixtos y puede costar distinto, así que se crea **un extra por plato**; queso y huevo se crean una vez con
  `applies_to_all = true`.
- `order_items.extras` (jsonb, default `[]`): snapshot por línea `[{ extraId, name, unitPrice, quantity }]`. Igual que
  `excluded_complements`, un pedido histórico no cambia si después se edita el precio o se da de baja el extra.

## API

| Endpoint | Rol | Qué hace |
|---|---|---|
| `GET /extras?includeInactive=true` | staff o servicio | Lista. Por defecto solo activos. |
| `POST /extras` | admin | `{ name, price, appliesToAll, productIds?, isActive?, sortOrder? }` |
| `PATCH /extras/:id` | admin | Parcial. `productIds` reemplaza la lista completa. |

Con `appliesToAll: false` hay que mandar al menos un `productId` (si no, `validation_error`).

## En el pedido

`POST /orders` → cada ítem acepta `extras: [{ extraId, quantity }]` (1–10 por extra, **por unidad** del producto).
El precio nunca viaja: sale del catálogo.

- `subtotal` de la línea = `(unitPriceSnapshot + Σ precio × quantity de los extras) × quantity`.
- `unitPriceSnapshot` es el precio del producto **solo**; los extras van en `items[].extras`.
- Otra selección de extras del mismo producto es **otra línea** (igual que con los complementos). Mismo producto + mismos
  complementos + mismos extras en dos líneas → `validation_error`.
- Errores: `unknown_extra` (400), `extra_not_for_product` (400), `extra_unavailable` (409, dado de baja).

Consumidores sin campo de extras (mensaje de confirmación de QR al agente) reciben los extras doblados en `name` y en
`unitPrice`, para que `cantidad × precio = subtotal` siga cerrando.

## Despliegue

1. Aplicar la migración `1700000045000_extras.sql` (`npm run migrate:up`). No borra ni modifica datos.
2. Desplegar el backend.

El orden no es crítico: el código nuevo **no escribe** `order_items.extras` cuando la línea no lleva extras, así que
funciona aunque se despliegue antes de la migración (solo los extras necesitan la migración). Rollback:
`npx node-pg-migrate down 1 --migration-file-language sql -m migrations`.

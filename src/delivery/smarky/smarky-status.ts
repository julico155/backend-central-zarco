import { OrderStatus } from '../../database/types';
import { SmarkyDeliveryStatus } from './smarky.types';

/** Estados de pedido desde los que un evento de la plataforma puede moverlo. */
const LIVE_ORDER_STATUSES: readonly OrderStatus[] = [
  'awaiting_location',
  'confirmed',
  'preparing',
  'ready',
  'out_for_delivery',
];

const TERMINAL_DELIVERY_STATUSES: readonly string[] = ['delivered', 'cancelled', 'failed'];

/** Entregas que la plataforma ya no atiende: el pedido vuelve al flujo propio de Zarco. */
const ABANDONED_DELIVERY_STATUSES: readonly string[] = ['cancelled', 'failed'];

export function isTerminalDeliveryStatus(status: string | null): boolean {
  return status !== null && TERMINAL_DELIVERY_STATUSES.includes(status);
}

/** `cancelled` / `failed`: la plataforma soltó el pedido; hay que atenderlo con los repartidores propios. */
export function isAbandonedDeliveryStatus(status: string | null): boolean {
  return status !== null && ABANDONED_DELIVERY_STATUSES.includes(status);
}

/**
 * Estado que debe tomar el pedido según el estado de la entrega, o `null` si no
 * cambia. La realidad de la calle manda: si el repartidor ya recogió el pedido,
 * pasa a `out_for_delivery` aunque cocina no lo haya marcado `ready`.
 *
 * - searching / assigned / at_restaurant: el pedido sigue en cocina; no cambia.
 * - in_transit  -> out_for_delivery
 * - delivered   -> delivered
 * - cancelled / failed -> NO cancelan el pedido: en producción el cliente ya pagó,
 *   así que el pedido sigue vivo y el webhook avisa al grupo propio para atenderlo a mano.
 * Un pedido ya entregado o cancelado nunca se mueve.
 */
export function orderStatusForDelivery(
  delivery: SmarkyDeliveryStatus,
  current: OrderStatus,
): OrderStatus | null {
  if (!LIVE_ORDER_STATUSES.includes(current)) return null;
  switch (delivery) {
    case 'in_transit':
      return current === 'out_for_delivery' ? null : 'out_for_delivery';
    case 'delivered':
      return 'delivered';
    default:
      return null;
  }
}

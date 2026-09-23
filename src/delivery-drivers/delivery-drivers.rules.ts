import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';
import { DashboardUserRole, OrderDeliveryType, OrderStatus } from '../database/types';

export type PresenceCheck =
  | { ok: true }
  | { ok: false; code: 'not_at_restaurant' | 'location_too_imprecise' };

/**
 * ¿El repartidor está en el local? Un GPS impreciso (accuracy peor que el
 * radio) no sirve para decidir: la posición real podría estar en cualquier
 * lado dentro del círculo de error, así que se pide reintentar en vez de
 * aceptar o rechazar a ciegas.
 */
export function checkDriverPresence(
  distanceMeters: number,
  accuracyMeters: number | undefined,
  radiusMeters: number,
): PresenceCheck {
  if (accuracyMeters !== undefined && accuracyMeters > radiusMeters) {
    return { ok: false, code: 'location_too_imprecise' };
  }
  if (distanceMeters > radiusMeters) return { ok: false, code: 'not_at_restaurant' };
  return { ok: true };
}

export function presenceException(
  check: Extract<PresenceCheck, { ok: false }>,
  distanceMeters: number,
  radiusMeters: number,
): DomainException {
  if (check.code === 'location_too_imprecise') {
    return new DomainException(
      'location_too_imprecise',
      HttpStatus.BAD_REQUEST,
      'La ubicación del celular es muy imprecisa. Activá el GPS de alta precisión y reintentá.',
      { radiusMeters },
    );
  }
  return new DomainException(
    'not_at_restaurant',
    HttpStatus.FORBIDDEN,
    'Tenés que estar en el local para aceptar el pedido.',
    { distanceMeters, radiusMeters },
  );
}

/**
 * Un pedido de delivery solo entra en reparto por el flujo del repartidor
 * (aceptar en el local) — la cocina no puede saltárselo marcándolo
 * out_for_delivery/delivered a mano. El admin queda como override.
 */
export function assertRoleCanMoveStatus(
  role: DashboardUserRole,
  deliveryType: OrderDeliveryType,
  to: OrderStatus,
): void {
  if (
    deliveryType === 'delivery' &&
    (to === 'out_for_delivery' || to === 'delivered') &&
    role !== 'admin'
  ) {
    throw new DomainException(
      'delivery_flow_only',
      HttpStatus.FORBIDDEN,
      'Los pedidos de delivery los toma y entrega un repartidor desde su pantalla.',
      { to },
    );
  }
}

export function mapsUrl(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
}

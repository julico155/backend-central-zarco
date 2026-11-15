/** Contrato con la plataforma central de reparto (docs/openapi.yaml de smarky-delivery-platform). */

export type SmarkyDeliveryStatus =
  | 'searching'
  | 'assigned'
  | 'at_restaurant'
  | 'in_transit'
  | 'delivered'
  | 'cancelled'
  | 'failed';

export const SMARKY_DELIVERY_STATUSES: readonly SmarkyDeliveryStatus[] = [
  'searching',
  'assigned',
  'at_restaurant',
  'in_transit',
  'delivered',
  'cancelled',
  'failed',
];

export interface SmarkyQuote {
  quoteId: string;
  distanceMeters: number;
  fee: string;
  estimatedMinutes: number;
  expiresAt: string;
}

export interface SmarkyDelivery {
  deliveryId: string;
  externalOrderId: string;
  status: SmarkyDeliveryStatus;
  fee: string;
  trackingUrl: string;
}

/** `deliveryCode` solo viene en la primera respuesta (201). */
export interface SmarkyDeliveryCreated extends SmarkyDelivery {
  deliveryCode?: string;
}

export interface SmarkyCreateDeliveryInput {
  externalOrderId: string;
  quoteId: string;
  customer: { name: string; phone: string };
  prepEtaMinutes: number;
  orderLabel?: string;
  dropoffReference?: string;
  /** Solo informativo para el repartidor. */
  paymentMethod?: 'cash' | 'qr';
  /** Efectivo por la COMIDA (sin envío), 2 decimales. Solo con `paymentMethod: 'cash'`. */
  cashToCollect?: string;
  /** Sin precios; máx 50. */
  items?: Array<{ name: string; quantity: number; notes?: string }>;
  /** Máx 500. */
  orderNotes?: string;
  /** Default true en la plataforma. Para no emitir código de entrega hay que mandar `false` explícito. */
  requireDeliveryCode?: boolean;
}

export interface SmarkyWebhookEvent {
  eventId: string;
  type: string;
  occurredAt: string;
  delivery: SmarkyDelivery;
}

import type { CustomerMessageComboItem, CustomerMessageOrderItem } from '../gateway-client/gateway-client.service';
import type { OrderItemResponse, OrderPromotionResponse, OrderResponse } from './orders.service';

export interface QrConfirmationContext {
  orderNumber: string;
  currency: 'BOB';
  deliveryType: 'delivery' | 'pickup' | 'dine_in';
  items: CustomerMessageOrderItem[];
  promotions: CustomerMessageComboItem[];
  subtotalAmount: number;
  deliveryBaseAmount: number;
  deliverySurchargeAmount: number;
  deliveryAmount: number;
  totalAmount: number;
  qrAmount: number;
}

/**
 * Central entrega el desglose completo; el agente arma el copy. `qrAmount`
 * es siempre `subtotalAmount` — el envío (si es delivery) se cobra en
 * efectivo al repartidor, nunca por QR (ver `sendQrConfirmation`).
 */
export function buildQrConfirmationContext(order: OrderResponse): QrConfirmationContext {
  return {
    orderNumber: order.orderNumber,
    currency: 'BOB',
    deliveryType: order.deliveryType as 'delivery' | 'pickup' | 'dine_in',
    items: order.items.map(toOrderItem),
    promotions: order.promotions.map(toComboItem),
    subtotalAmount: order.subtotalAmount,
    deliveryBaseAmount: order.deliveryBaseAmount,
    deliverySurchargeAmount: order.deliverySurchargeAmount,
    deliveryAmount: order.deliveryBaseAmount + order.deliverySurchargeAmount,
    totalAmount: order.totalAmount,
    qrAmount: order.subtotalAmount,
  };
}

function toOrderItem(item: OrderItemResponse): CustomerMessageOrderItem {
  return {
    name: item.productNameSnapshot,
    quantity: item.quantity,
    unitPrice: item.unitPriceSnapshot,
    subtotal: item.subtotal,
    excludedComplements: item.excludedComplements,
  };
}

function toComboItem(promotion: OrderPromotionResponse): CustomerMessageComboItem {
  return {
    name: promotion.promotionNameSnapshot,
    quantity: promotion.comboQuantity,
    unitPrice: promotion.promoPriceSnapshot,
    subtotal: promotion.subtotal,
    components: promotion.componentsSnapshot.map((component) => ({
      name: component.name,
      quantity: component.quantity,
    })),
  };
}

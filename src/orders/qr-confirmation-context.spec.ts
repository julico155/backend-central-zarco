import { buildQrConfirmationContext } from './qr-confirmation-context';
import { OrderResponse } from './orders.service';

function baseOrder(overrides: Partial<OrderResponse> = {}): OrderResponse {
  return {
    id: 'order-1',
    orderNumber: 'ORD-260929-007',
    customerId: 'customer-1',
    channel: 'whatsapp',
    customerName: 'Juan Pérez',
    deliveryType: 'delivery',
    paymentMethod: 'qr',
    paymentStatus: 'unpaid',
    status: 'confirmed',
    notes: null,
    subtotalAmount: 22,
    deliveryBaseAmount: 8,
    deliverySurchargeAmount: 2,
    totalAmount: 32,
    deliveryQuoteStatus: 'quoted',
    deliveryDistanceMeters: 4200,
    cashConfirmedAt: null,
    splitCashAmount: null,
    splitQrAmount: null,
    splitCashConfirmedAt: null,
    statusUpdatedBy: null,
    deliveryDriverName: null,
    deliveryAcceptedAt: null,
    deliveredAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    items: [
      {
        productId: 'p1',
        productCodeSnapshot: 'TRP',
        productNameSnapshot: 'Trancapecho',
        unitPriceSnapshot: 18,
        quantity: 1,
        subtotal: 18,
        excludedComplements: [],
        extras: [],
      },
      {
        productId: 'p2',
        productCodeSnapshot: 'LIM',
        productNameSnapshot: 'Limonada',
        unitPriceSnapshot: 4,
        quantity: 1,
        subtotal: 4,
        excludedComplements: [],
        extras: [],
      },
    ],
    promotions: [],
    ...overrides,
  };
}

describe('buildQrConfirmationContext', () => {
  it('desglosa productos, subtotal, envío y monto autoritativo del QR (delivery)', () => {
    const context = buildQrConfirmationContext(baseOrder());

    expect(context).toEqual({
      orderNumber: 'ORD-260929-007',
      currency: 'BOB',
      deliveryType: 'delivery',
      items: [
        { name: 'Trancapecho', quantity: 1, unitPrice: 18, subtotal: 18, excludedComplements: [] },
        { name: 'Limonada', quantity: 1, unitPrice: 4, subtotal: 4, excludedComplements: [] },
      ],
      promotions: [],
      subtotalAmount: 22,
      deliveryBaseAmount: 8,
      deliverySurchargeAmount: 2,
      deliveryAmount: 10,
      totalAmount: 32,
      qrAmount: 22,
    });
  });

  it('una línea con extras dobla los extras en el nombre y en el precio unitario, para que cantidad × precio = subtotal', () => {
    const context = buildQrConfirmationContext(
      baseOrder({
        deliveryType: 'pickup',
        deliveryBaseAmount: 0,
        deliverySurchargeAmount: 0,
        subtotalAmount: 84,
        totalAmount: 84,
        items: [
          {
            productId: 'p1',
            productCodeSnapshot: 'TRP',
            productNameSnapshot: 'Trancapecho',
            unitPriceSnapshot: 18,
            quantity: 3,
            // 3 × (18 + 2 carnes de 5 + 1 queso de 0) = 84
            subtotal: 84,
            excludedComplements: [],
            extras: [
              { extraId: 'e1', name: 'Carne', unitPrice: 5, quantity: 2 },
              { extraId: 'e2', name: 'Queso', unitPrice: 0, quantity: 1 },
            ],
          },
        ],
      }),
    );

    expect(context.items).toEqual([
      { name: 'Trancapecho (+2 Carne, +1 Queso)', quantity: 3, unitPrice: 28, subtotal: 84, excludedComplements: [] },
    ]);
    expect(context.qrAmount).toBe(84);
  });

  it('pickup/mesa: deliveryAmount queda en 0, qrAmount sigue siendo el subtotal', () => {
    const context = buildQrConfirmationContext(
      baseOrder({
        deliveryType: 'pickup',
        deliveryBaseAmount: 0,
        deliverySurchargeAmount: 0,
        totalAmount: 22,
      }),
    );

    expect(context.deliveryType).toBe('pickup');
    expect(context.deliveryAmount).toBe(0);
    expect(context.qrAmount).toBe(22);
    expect(context.totalAmount).toBe(22);
  });

  it('incluye combos con sus componentes', () => {
    const context = buildQrConfirmationContext(
      baseOrder({
        items: [],
        promotions: [
          {
            promotionId: 'promo-1',
            promotionNameSnapshot: 'Combo Trancapecho',
            promoPriceSnapshot: 20,
            comboQuantity: 1,
            subtotal: 20,
            componentsSnapshot: [
              { productId: 'p1', code: 'TRP', name: 'Trancapecho', unitPrice: 18, quantity: 1 },
              { productId: 'p3', code: 'GAS', name: 'Gaseosa', unitPrice: 2, quantity: 1 },
            ],
          },
        ],
      }),
    );

    expect(context.promotions).toEqual([
      {
        name: 'Combo Trancapecho',
        quantity: 1,
        unitPrice: 20,
        subtotal: 20,
        components: [
          { name: 'Trancapecho', quantity: 1 },
          { name: 'Gaseosa', quantity: 1 },
        ],
      },
    ]);
  });
});

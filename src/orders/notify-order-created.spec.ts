import { OrderResponse, OrdersService } from './orders.service';

const baseOrder: OrderResponse = {
  id: 'order-1',
  orderNumber: 'ORD-260929-007',
  customerId: 'customer-1',
  channel: 'whatsapp',
  customerName: 'Juan Pérez',
  deliveryType: 'delivery',
  paymentMethod: 'qr',
  paymentStatus: 'unpaid',
  status: 'awaiting_location',
  notes: null,
  subtotalAmount: 42,
  deliveryBaseAmount: 0,
  deliverySurchargeAmount: 0,
  totalAmount: 42,
  deliveryQuoteStatus: 'pending',
  deliveryDistanceMeters: null,
  cashConfirmedAt: null,
  splitCashAmount: null,
  splitQrAmount: null,
  splitCashConfirmedAt: null,
  statusUpdatedBy: null,
  deliveryDriverName: null,
  deliveryAcceptedAt: null,
  deliveredAt: null,
  createdAt: '2026-09-29T00:00:00.000Z',
  updatedAt: '2026-09-29T00:00:00.000Z',
  items: [],
  promotions: [],
};

function createService() {
  const notifications = { notifyNow: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn() };
  const service = new OrdersService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    notifications as never,
    {} as never,
    {} as never,
    config as never,
  );
  return { service, notifications, config };
}

/** notifyOrderCreated es privado: se llama tal cual lo hace create() tras el commit. */
async function notifyOrderCreated(service: OrdersService, order: OrderResponse): Promise<void> {
  await (service as unknown as { notifyOrderCreated(order: OrderResponse): Promise<void> }).notifyOrderCreated(
    order,
  );
}

describe('OrdersService.notifyOrderCreated', () => {
  it('sends a single location_request (with orderNumber) for a delivery order, never order_received', async () => {
    const { service, notifications } = createService();

    await notifyOrderCreated(service, { ...baseOrder, status: 'awaiting_location' });

    expect(notifications.notifyNow).toHaveBeenCalledTimes(1);
    expect(notifications.notifyNow).toHaveBeenCalledWith({
      channel: 'whatsapp',
      kind: 'location_request',
      targetRef: 'order-1',
      payload: { customerId: 'customer-1', reason: 'delivery_location', orderNumber: 'ORD-260929-007' },
    });
    expect(notifications.notifyNow).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'order_received' }),
    );
  });

  it('keeps order_received for pickup (confirmed at creation, no QR since paymentMethod is cash)', async () => {
    const { service, notifications } = createService();

    await notifyOrderCreated(service, {
      ...baseOrder,
      status: 'confirmed',
      deliveryType: 'pickup',
      paymentMethod: 'cash',
    });

    expect(notifications.notifyNow).toHaveBeenCalledWith({
      channel: 'whatsapp',
      kind: 'order_received',
      targetRef: 'order-1',
      payload: {
        customerId: 'customer-1',
        messageType: 'order_received',
        context: { orderNumber: 'ORD-260929-007', deliveryType: 'pickup' },
      },
    });
    expect(notifications.notifyNow).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'location_request' }),
    );
  });

  it('sends cash_on_delivery_confirmation with the full total (comida + envío) for a cash pickup order', async () => {
    const { service, notifications } = createService();

    await notifyOrderCreated(service, {
      ...baseOrder,
      status: 'confirmed',
      deliveryType: 'pickup',
      paymentMethod: 'cash',
      totalAmount: 42,
    });

    expect(notifications.notifyNow).toHaveBeenCalledWith({
      channel: 'whatsapp',
      kind: 'cash_on_delivery_confirmation',
      targetRef: 'order-1',
      payload: {
        customerId: 'customer-1',
        messageType: 'cash_on_delivery_confirmation',
        context: { orderNumber: 'ORD-260929-007', deliveryType: 'pickup', totalAmount: 42 },
      },
    });
    // Nunca genera/manda un QR para un pedido en efectivo.
    expect(notifications.notifyNow).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'qr_confirmation' }),
    );
  });

  it('a failed gateway on location_request does not throw (best-effort)', async () => {
    const { service, notifications } = createService();
    notifications.notifyNow.mockRejectedValueOnce(new Error('gateway down'));

    await expect(
      notifyOrderCreated(service, { ...baseOrder, status: 'awaiting_location' }),
    ).resolves.toBeUndefined();
  });
});

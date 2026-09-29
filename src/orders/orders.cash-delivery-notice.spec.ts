import { OrdersService } from './orders.service';

type CashPaymentNotifier = {
  notifyCashPaymentFinalized(
    order: { id: string; order_number: string; customer_id: string | null },
    fullyPaid: boolean,
  ): Promise<void>;
};

function createService() {
  const notifications = { notifyNow: jest.fn().mockResolvedValue(undefined) };
  const deliveryNotices = { notifyConfirmed: jest.fn().mockResolvedValue(undefined) };
  const service = new OrdersService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    notifications as never,
    {} as never,
    {} as never,
    deliveryNotices as never,
    {} as never,
  );
  return { service, notifications, deliveryNotices };
}

describe('OrdersService cash delivery notice', () => {
  it('uses the shared delivery_notice after the cash CAS makes the order fully paid', async () => {
    const { service, notifications, deliveryNotices } = createService();
    const cashNotifier = service as unknown as CashPaymentNotifier;

    await cashNotifier.notifyCashPaymentFinalized(
      { id: 'order-1', order_number: 'ORD-0007', customer_id: 'customer-1' },
      true,
    );

    expect(notifications.notifyNow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'cash_confirmed_customer_notice' }),
    );
    expect(deliveryNotices.notifyConfirmed).toHaveBeenCalledTimes(1);
    expect(deliveryNotices.notifyConfirmed).toHaveBeenCalledWith('order-1');
  });

  it('does not notify delivery before a split is fully paid', async () => {
    const { service, deliveryNotices } = createService();
    const cashNotifier = service as unknown as CashPaymentNotifier;

    await cashNotifier.notifyCashPaymentFinalized(
      { id: 'order-1', order_number: 'ORD-0007', customer_id: 'customer-1' },
      false,
    );

    expect(deliveryNotices.notifyConfirmed).not.toHaveBeenCalled();
  });

  it('does not turn a committed cash confirmation into an error when delivery Telegram fails', async () => {
    const { service, deliveryNotices } = createService();
    const cashNotifier = service as unknown as CashPaymentNotifier;
    deliveryNotices.notifyConfirmed.mockRejectedValue(new Error('telegram unavailable'));

    await expect(cashNotifier.notifyCashPaymentFinalized(
        { id: 'order-1', order_number: 'ORD-0007', customer_id: 'customer-1' },
        true,
      )).resolves.toBeUndefined();
  });
});

import { PaymentAttemptsService } from './payment-attempts.service';

type Scenario = {
  decision: 'accepted' | 'rejected';
  casWinner?: boolean;
  paymentMethod?: 'qr' | 'split';
  splitCashConfirmed?: boolean;
  deliveryRejects?: boolean;
};

function createService(scenario: Scenario) {
  const attempt = {
    id: 'attempt-1',
    order_id: 'order-1',
    customer_id: 'customer-1',
    opened_at: new Date('2026-09-29T00:00:00.000Z'),
    opened_as: 'normal',
    review_status: 'pending_review',
    reviewed_at: null,
  };
  const currentOrder = {
    register_session_id: null,
    payment_method: scenario.paymentMethod ?? 'qr',
    split_cash_confirmed_at: scenario.splitCashConfirmed ? new Date() : null,
  };

  const attemptsUpdate = {
    set: jest.fn(),
    where: jest.fn(),
    returningAll: jest.fn(),
  };
  attemptsUpdate.set.mockReturnValue(attemptsUpdate);
  attemptsUpdate.where.mockReturnValue(attemptsUpdate);
  attemptsUpdate.returningAll.mockReturnValue({
    executeTakeFirst: jest.fn().mockResolvedValue(scenario.casWinner === false ? undefined : attempt),
  });

  const orderUpdate = { set: jest.fn(), where: jest.fn(), returning: jest.fn() };
  orderUpdate.set.mockReturnValue(orderUpdate);
  orderUpdate.where.mockReturnValue(orderUpdate);
  orderUpdate.returning.mockReturnValue({
    executeTakeFirstOrThrow: jest.fn().mockResolvedValue({ customer_id: 'customer-1' }),
  });

  const orderSelect = { select: jest.fn(), where: jest.fn(), executeTakeFirstOrThrow: jest.fn() };
  orderSelect.select.mockReturnValue(orderSelect);
  orderSelect.where.mockReturnValue(orderSelect);
  orderSelect.executeTakeFirstOrThrow.mockResolvedValue(currentOrder);

  const replaySelect = { selectAll: jest.fn(), where: jest.fn(), executeTakeFirst: jest.fn() };
  replaySelect.selectAll.mockReturnValue(replaySelect);
  replaySelect.where.mockReturnValue(replaySelect);
  replaySelect.executeTakeFirst.mockResolvedValue({ ...attempt, review_status: scenario.decision });

  const trx = {
    updateTable: jest.fn((table: string) => (table === 'payment_attempts' ? attemptsUpdate : orderUpdate)),
    selectFrom: jest.fn((table: string) => (table === 'payment_attempts' ? replaySelect : orderSelect)),
  };
  const db = { transaction: () => ({ execute: async (fn: (value: typeof trx) => unknown) => fn(trx) }) };
  const notifications = { notifyNow: jest.fn().mockResolvedValue(undefined) };
  const cashRegister = { assertOpenSessionId: jest.fn().mockResolvedValue('register-1') };
  const deliveryNotices = {
    notifyConfirmed: scenario.deliveryRejects
      ? jest.fn().mockRejectedValue(new Error('telegram unavailable'))
      : jest.fn().mockResolvedValue(undefined),
  };
  return {
    service: new PaymentAttemptsService(db as never, notifications as never, cashRegister as never, deliveryNotices as never),
    deliveryNotices,
  };
}

describe('PaymentAttemptsService delivery notice trigger', () => {
  it('notifies delivery only after an accepted QR decision makes the order paid', async () => {
    const { service, deliveryNotices } = createService({ decision: 'accepted' });

    await service.decide('attempt-1', 'accepted');

    expect(deliveryNotices.notifyConfirmed).toHaveBeenCalledWith('order-1');
  });

  it('does not notify for a rejected decision', async () => {
    const { service, deliveryNotices } = createService({ decision: 'rejected' });

    await service.decide('attempt-1', 'rejected');

    expect(deliveryNotices.notifyConfirmed).not.toHaveBeenCalled();
  });

  it('does not notify when the payment-attempt CAS replay loses', async () => {
    const { service, deliveryNotices } = createService({ decision: 'accepted', casWinner: false });

    await service.decide('attempt-1', 'accepted');

    expect(deliveryNotices.notifyConfirmed).not.toHaveBeenCalled();
  });

  it('does not notify after only the QR leg of an unpaid split', async () => {
    const { service, deliveryNotices } = createService({
      decision: 'accepted',
      paymentMethod: 'split',
      splitCashConfirmed: false,
    });

    await service.decide('attempt-1', 'accepted');

    expect(deliveryNotices.notifyConfirmed).not.toHaveBeenCalled();
  });

  it('notifies once when an accepted QR leg completes a split', async () => {
    const { service, deliveryNotices } = createService({
      decision: 'accepted',
      paymentMethod: 'split',
      splitCashConfirmed: true,
    });

    await service.decide('attempt-1', 'accepted');

    expect(deliveryNotices.notifyConfirmed).toHaveBeenCalledTimes(1);
    expect(deliveryNotices.notifyConfirmed).toHaveBeenCalledWith('order-1');
  });

  it('keeps an accepted payment decision successful when Telegram notification fails', async () => {
    const { service } = createService({ decision: 'accepted', deliveryRejects: true });

    await expect(service.decide('attempt-1', 'accepted')).resolves.toMatchObject({ won: true });
  });
});

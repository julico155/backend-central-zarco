import { NotificationsOutService } from './notifications-out.service';

function createService(
  claimAttempts: Array<number | undefined>,
  insertResults: Array<{ id: string } | undefined> = [{ id: 'job-1' }],
) {
  const claimResults = [...claimAttempts];
  const inserted = { id: 'job-1' };
  const insert = {
    values: jest.fn(),
    onConflict: jest.fn(),
    returning: jest.fn(),
  };
  insert.values.mockReturnValue(insert);
  insert.onConflict.mockReturnValue(insert);
  insert.returning.mockReturnValue({
    executeTakeFirst: jest.fn().mockImplementation(async () => insertResults.shift()),
  });

  const existing = { select: jest.fn(), where: jest.fn(), executeTakeFirstOrThrow: jest.fn() };
  existing.select.mockReturnValue(existing);
  existing.where.mockReturnValue(existing);
  existing.executeTakeFirstOrThrow.mockResolvedValue(inserted);

  const db = {
    insertInto: jest.fn().mockReturnValue(insert),
    selectFrom: jest.fn().mockReturnValue(existing),
    updateTable: jest.fn(() => {
      const update = { set: jest.fn(), where: jest.fn(), returning: jest.fn(), execute: jest.fn() };
      update.set.mockReturnValue(update);
      update.where.mockReturnValue(update);
      update.returning.mockReturnValue({
        executeTakeFirst: jest.fn().mockImplementation(async () => {
          const attempts = claimResults.shift();
          return attempts === undefined ? undefined : { attempts };
        }),
      });
      update.execute.mockResolvedValue([]);
      return update;
    }),
  };
  const gateway = { sendTelegramAlert: jest.fn().mockResolvedValue({ externalMessageId: 'telegram-1' }) };
  return {
    service: new NotificationsOutService(db as never, gateway as never),
    gateway,
  };
}

const deliveryNotice = {
  channel: 'telegram' as const,
  kind: 'delivery_notice',
  targetRef: 'order-1',
  payload: { chatRef: 'delivery-group', text: 'private delivery text' },
};

describe('NotificationsOutService fast-path claim', () => {
  it('sends the same delivery_notice twice only once', async () => {
    const { service, gateway } = createService([1, undefined], [{ id: 'job-1' }, undefined]);

    await service.notifyNow(deliveryNotice);
    await service.notifyNow(deliveryNotice);

    expect(gateway.sendTelegramAlert).toHaveBeenCalledTimes(1);
  });

  it('does not resend a job that is already sent', async () => {
    const { service, gateway } = createService([undefined]);

    await service.notifyNow(deliveryNotice);

    expect(gateway.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('lets only one concurrent claimant send', async () => {
    const { service, gateway } = createService([1, undefined], [{ id: 'job-1' }, undefined]);

    await Promise.all([service.notifyNow(deliveryNotice), service.notifyNow(deliveryNotice)]);

    expect(gateway.sendTelegramAlert).toHaveBeenCalledTimes(1);
  });

  it('allows a pending or failed eligible job to be retried after its claim', async () => {
    const { service, gateway } = createService([3]);

    await service.notifyNow(deliveryNotice);

    expect(gateway.sendTelegramAlert).toHaveBeenCalledTimes(1);
  });
});

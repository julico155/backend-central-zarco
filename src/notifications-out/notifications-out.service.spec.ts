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

  const updates: Array<{ where: jest.Mock }> = [];
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
      updates.push(update);
      return update;
    }),
  };
  const gateway = { sendTelegramAlert: jest.fn().mockResolvedValue({ externalMessageId: 'telegram-1' }) };
  return {
    service: new NotificationsOutService(db as never, gateway as never),
    gateway,
    updates,
  };
}

const deliveryNotice = {
  channel: 'telegram' as const,
  kind: 'delivery_notice',
  targetRef: 'order-1',
  payload: { chatRef: 'delivery-group', text: 'private delivery text' },
};

describe('NotificationsOutService fast-path claim', () => {
  it('claims and sends a normal pending job', async () => {
    const { service, gateway, updates } = createService([1]);

    await service.notifyNow(deliveryNotice);

    expect(gateway.sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(updates[0].where).toHaveBeenCalledWith('status', 'in', ['pending', 'failed']);
    expect(updates[0].where).toHaveBeenCalledWith('attempts', '<', 8);
    expect(updates[0].where).toHaveBeenCalledWith(expect.any(Function));
  });

  it('claims and sends a failed job whose next attempt is due', async () => {
    const { service, gateway } = createService([2], [undefined]);

    await service.notifyNow(deliveryNotice);

    expect(gateway.sendTelegramAlert).toHaveBeenCalledTimes(1);
  });

  it('does not send a failed job before its next_attempt_at', async () => {
    const { service, gateway } = createService([undefined], [undefined]);

    await service.notifyNow(deliveryNotice);

    expect(gateway.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('does not send a job at MAX_ATTEMPTS', async () => {
    const { service, gateway } = createService([undefined], [undefined]);

    await service.notifyNow(deliveryNotice);

    expect(gateway.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('does not send a job beyond MAX_ATTEMPTS', async () => {
    const { service, gateway } = createService([undefined], [undefined]);

    await service.notifyNow(deliveryNotice);

    expect(gateway.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('does not resend a sent job', async () => {
    const { service, gateway } = createService([undefined], [undefined]);

    await service.notifyNow(deliveryNotice);

    expect(gateway.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('does not send a job another process is already sending', async () => {
    const { service, gateway } = createService([undefined], [undefined]);

    await service.notifyNow(deliveryNotice);

    expect(gateway.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('lets only one concurrent claimant send', async () => {
    const { service, gateway } = createService([1, undefined], [{ id: 'job-1' }, undefined]);

    await Promise.all([service.notifyNow(deliveryNotice), service.notifyNow(deliveryNotice)]);

    expect(gateway.sendTelegramAlert).toHaveBeenCalledTimes(1);
  });

  it('sends the same delivery_notice twice only once', async () => {
    const { service, gateway } = createService([1, undefined], [{ id: 'job-1' }, undefined]);

    await service.notifyNow(deliveryNotice);
    await service.notifyNow(deliveryNotice);

    expect(gateway.sendTelegramAlert).toHaveBeenCalledTimes(1);
  });
});

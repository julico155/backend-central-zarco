import { DeliveryService } from './delivery.service';

type Result = { result: 'applied' | 'already_applied' | 'pending_manual' };

function setup() {
  const deliveryNotice = { tryNotify: jest.fn().mockResolvedValue('enqueued') };
  const service = new DeliveryService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    deliveryNotice as never,
  );
  const internals = service as unknown as {
    applyQuoteForOrder(id: string): Promise<Result>;
    applyManualQuote(id: string, amount: number): Promise<Result>;
  };
  return { service, deliveryNotice, internals };
}

describe('DeliveryService → aviso al grupo de motos al cerrar la cotización', () => {
  it('cotización aplicada (pago ya listo o no): intenta el aviso; la condición la decide DeliveryNoticeService', async () => {
    const h = setup();
    jest.spyOn(h.internals, 'applyQuoteForOrder').mockResolvedValue({ result: 'applied' });

    await h.service.quoteForOrder('order-1');

    expect(h.deliveryNotice.tryNotify).toHaveBeenCalledWith('order-1');
  });

  it.each<Result['result']>(['already_applied', 'pending_manual'])(
    'cotización %s no dispara el aviso',
    async (result) => {
      const h = setup();
      jest.spyOn(h.internals, 'applyQuoteForOrder').mockResolvedValue({ result });

      await h.service.quoteForOrder('order-1');

      expect(h.deliveryNotice.tryNotify).not.toHaveBeenCalled();
    },
  );

  it('cotización manual aplicada dispara el aviso; ya aplicada no', async () => {
    const h = setup();
    const spy = jest.spyOn(h.internals, 'applyManualQuote');

    spy.mockResolvedValueOnce({ result: 'applied' });
    await h.service.setManualQuote('order-1', 20);
    expect(h.deliveryNotice.tryNotify).toHaveBeenCalledTimes(1);

    spy.mockResolvedValueOnce({ result: 'already_applied' });
    await h.service.setManualQuote('order-1', 20);
    expect(h.deliveryNotice.tryNotify).toHaveBeenCalledTimes(1);
  });
});

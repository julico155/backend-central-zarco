import { OrdersService } from './orders.service';

/**
 * Cierre forzado de fin de jornada (KitchenAutoCompleteCron): verifica que
 * la query apunte a los status correctos, pase a delivered sin tocar
 * payment_status, y use el cutoff recibido (no recalcule nada acá — eso es
 * responsabilidad de lastClosesHourCrossing, ya testeado aparte).
 */
function createService() {
  const update: Record<string, jest.Mock> = {
    set: jest.fn(),
    where: jest.fn(),
    executeTakeFirst: jest.fn().mockResolvedValue({ numUpdatedRows: 3n }),
  };
  update.set.mockReturnValue(update);
  update.where.mockReturnValue(update);

  const db = { updateTable: jest.fn().mockReturnValue(update) };
  const service = new OrdersService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, update, db };
}

describe('OrdersService.autoCompletePendingKitchenOrders', () => {
  it('pasa confirmed/preparing/ready/out_for_delivery creados antes del cutoff a delivered, sin tocar payment_status', async () => {
    const { service, update } = createService();
    const cutoff = new Date('2026-10-20T04:00:00.000Z');

    const result = await service.autoCompletePendingKitchenOrders(cutoff);

    expect(result).toBe(3);
    expect(update.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'delivered',
        status_updated_by: 'system:auto-close',
      }),
    );
    const setArg = update.set.mock.calls[0][0];
    expect(setArg).not.toHaveProperty('payment_status');
    expect(update.where).toHaveBeenCalledWith(
      'status',
      'in',
      ['confirmed', 'preparing', 'ready', 'out_for_delivery'],
    );
    expect(update.where).toHaveBeenCalledWith('created_at', '<', cutoff);
  });

  it('devuelve 0 si no hay nada que cerrar', async () => {
    const { service, update } = createService();
    update.executeTakeFirst.mockResolvedValue({ numUpdatedRows: 0n });

    const result = await service.autoCompletePendingKitchenOrders(new Date());

    expect(result).toBe(0);
  });
});

import { OrdersService } from './orders.service';

/**
 * Regresión del bug real: payment_method='cash' quedaba sin pagar a
 * propósito hasta la entrega/retiro, pero el cron de vencimiento lo trataba
 * igual que un QR abandonado y lo cancelaba a los ttlMinutes aunque cocina
 * todavía no lo hubiera movido a preparing. La exclusión ya existió una vez
 * (se perdió sin querer en un refactor) — este test evita que vuelva a
 * desaparecer sin que falle algo.
 */
function createService() {
  const where = jest.fn();
  const selectQuery: Record<string, jest.Mock> = {
    select: jest.fn(),
    where,
    orderBy: jest.fn(),
    limit: jest.fn(),
    execute: jest.fn().mockResolvedValue([]),
  };
  selectQuery.select.mockReturnValue(selectQuery);
  where.mockReturnValue(selectQuery);
  selectQuery.orderBy.mockReturnValue(selectQuery);
  selectQuery.limit.mockReturnValue(selectQuery);

  const db = {
    selectFrom: jest.fn().mockReturnValue(selectQuery),
    updateTable: jest.fn(),
  };
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
  return { service, where };
}

describe('OrdersService.expireUnpaidOrders — exclusión de cash contra entrega/retiro', () => {
  it('nunca selecciona payment_method=cash como candidato a cancelar', async () => {
    const { service, where } = createService();

    await service.expireUnpaidOrders(20);

    expect(where).toHaveBeenCalledWith('payment_method', '!=', 'cash');
  });
});

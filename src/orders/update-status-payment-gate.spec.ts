import { DomainException } from '../common/exceptions/domain-exception';
import { OrderPaymentMethod, OrderPaymentStatus } from '../database/types';
import { OrdersService } from './orders.service';

interface FakeOrder {
  id: string;
  order_number: string;
  status: string;
  delivery_type: 'delivery';
  payment_method: OrderPaymentMethod;
  payment_status: OrderPaymentStatus;
  created_at: Date;
  updated_at: Date;
  delivered_at: Date | null;
}

const baseOrder: FakeOrder = {
  id: 'order-1',
  order_number: 'ORD-0001',
  status: 'confirmed',
  delivery_type: 'delivery',
  payment_method: 'cash',
  payment_status: 'unpaid',
  created_at: new Date('2026-10-06T00:00:00.000Z'),
  updated_at: new Date('2026-10-06T00:00:00.000Z'),
  delivered_at: null,
};

function createService(order: FakeOrder) {
  const lockedOrder = { selectAll: jest.fn(), where: jest.fn(), executeTakeFirst: jest.fn().mockResolvedValue(order) };
  lockedOrder.selectAll.mockReturnValue(lockedOrder);
  lockedOrder.where.mockReturnValue(lockedOrder);

  const updateOrder = { set: jest.fn(), where: jest.fn(), returningAll: jest.fn() };
  updateOrder.set.mockReturnValue(updateOrder);
  updateOrder.where.mockReturnValue(updateOrder);
  updateOrder.returningAll.mockReturnValue({
    executeTakeFirst: jest.fn().mockResolvedValue({ ...order, status: 'preparing' }),
  });

  const items = { selectAll: jest.fn(), where: jest.fn(), execute: jest.fn().mockResolvedValue([]) };
  items.selectAll.mockReturnValue(items);
  items.where.mockReturnValue(items);
  const promotions = { selectAll: jest.fn(), where: jest.fn(), execute: jest.fn().mockResolvedValue([]) };
  promotions.selectAll.mockReturnValue(promotions);
  promotions.where.mockReturnValue(promotions);

  const db = {
    selectFrom: jest.fn((table: string) => {
      if (table === 'orders') return lockedOrder;
      if (table === 'order_items') return items;
      return promotions;
    }),
    updateTable: jest.fn().mockReturnValue(updateOrder),
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
  );
  return { service };
}

describe('OrdersService.updateStatus — gate de pago antes de preparing', () => {
  it('deja pasar un pedido payment_method=cash todavía unpaid (pago contra entrega)', async () => {
    const { service } = createService(baseOrder);

    const result = await service.updateStatus('order-1', 'preparing', 'cocinero1', 'kitchen');
    expect(result.status).toBe('preparing');
  });

  it('sigue exigiendo paid para QR (sin excepción) — no es un cambio accidental de regla', async () => {
    const { service } = createService({ ...baseOrder, payment_method: 'qr', payment_status: 'unpaid' });

    await expect(service.updateStatus('order-1', 'preparing', 'cocinero1', 'kitchen')).rejects.toMatchObject({
      code: 'payment_required',
    });
  });

  it('sigue exigiendo paid para split (sin excepción)', async () => {
    const { service } = createService({ ...baseOrder, payment_method: 'split', payment_status: 'unpaid' });

    await expect(service.updateStatus('order-1', 'preparing', 'cocinero1', 'kitchen')).rejects.toBeInstanceOf(
      DomainException,
    );
  });

  it('un pedido cash ya pagado (ej. confirmado a mano antes) también pasa, como siempre', async () => {
    const { service } = createService({ ...baseOrder, payment_status: 'paid' });

    const result = await service.updateStatus('order-1', 'preparing', 'cocinero1', 'kitchen');
    expect(result.status).toBe('preparing');
  });
});

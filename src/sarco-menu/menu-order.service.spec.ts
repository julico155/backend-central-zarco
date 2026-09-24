import { MenuOrderService } from './menu-order.service';
import { WHATSAPP_API_CLIENT } from '../orders/order-channel';
import { SubmitMenuOrderDto } from './dto/submit-menu-order.dto';

/** Fake mínimo del query builder de Kysely: solo la cadena que usa `resolveItems`. */
function fakeDb(products: { id: string; code: string }[]) {
  return {
    selectFrom: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          execute: jest.fn().mockResolvedValue(products),
        }),
      }),
    }),
  };
}

function fakeSessionRepo(session: unknown) {
  return { findByHash: jest.fn().mockResolvedValue(session) };
}

function fakeCustomers(customerId = 'customer-1') {
  return {
    findOrCreate: jest
      .fn()
      .mockResolvedValue({ id: customerId, name: null, phone: '59170000000', email: null }),
  };
}

function fakeOrders(outcome: unknown = { httpStatus: 201, body: { id: 'order-1' } }) {
  return { create: jest.fn().mockResolvedValue(outcome) };
}

const validSession = {
  id: 'session-1',
  sourceMessageId: 'wamid.1',
  tokenHash: 'a'.repeat(64),
  customerPhone: '59170000000',
  phoneNumberId: 'phone-1',
  expiresAt: '2026-01-01T02:00:00.000Z',
  replacesOrderId: null,
};

function cart(overrides: Partial<SubmitMenuOrderDto> = {}): SubmitMenuOrderDto {
  const dto = new SubmitMenuOrderDto();
  dto.session_token = 'token-abc';
  dto.customer_name = 'Juan';
  dto.delivery_type = 'delivery';
  dto.payment_method = 'qr';
  dto.items = [{ code: 'trancapecho', quantity: 2 }];
  Object.assign(dto, overrides);
  return dto;
}

describe('MenuOrderService', () => {
  it('crea el pedido llamando a OrdersService.create (nunca al RPC create_order_web_v4, que no existe en este backend)', async () => {
    const orders = fakeOrders();
    const db = fakeDb([{ id: 'prod-1', code: 'trancapecho' }]);
    const service = new MenuOrderService(
      db as never,
      fakeSessionRepo(validSession) as never,
      fakeCustomers() as never,
      orders as never,
    );

    const outcome = await service.submit(cart());

    expect(orders.create).toHaveBeenCalledTimes(1);
    const [dto, idempotencyKey, apiClient] = orders.create.mock.calls[0];
    expect(apiClient).toBe(WHATSAPP_API_CLIENT);
    expect(dto.channel).toBe('whatsapp');
    expect(dto.items).toEqual([
      { productId: 'prod-1', quantity: 2, excludedComplements: undefined },
    ]);
    expect(idempotencyKey).toBe('session-1');
    expect(outcome).toEqual({ httpStatus: 201, body: { id: 'order-1' } });
  });

  it('el teléfono SIEMPRE sale de la sesión, nunca del body del cliente', async () => {
    const customers = fakeCustomers();
    const service = new MenuOrderService(
      fakeDb([{ id: 'prod-1', code: 'trancapecho' }]) as never,
      fakeSessionRepo(validSession) as never,
      customers as never,
      fakeOrders() as never,
    );

    await service.submit(cart());

    expect(customers.findOrCreate).toHaveBeenCalledWith({ phone: '59170000000' });
  });

  it('sesión inválida o vencida: 401, no llega a tocar OrdersService', async () => {
    const orders = fakeOrders();
    const service = new MenuOrderService(
      fakeDb([]) as never,
      fakeSessionRepo(null) as never, // findByHash ya filtra expires_at > now() — null = inválida o vencida
      fakeCustomers() as never,
      orders as never,
    );

    await expect(service.submit(cart())).rejects.toMatchObject({ status: 401 });
    expect(orders.create).not.toHaveBeenCalled();
  });

  it('payment_method se conserva: qr llega intacto a OrdersService', async () => {
    const orders = fakeOrders();
    const service = new MenuOrderService(
      fakeDb([{ id: 'prod-1', code: 'trancapecho' }]) as never,
      fakeSessionRepo(validSession) as never,
      fakeCustomers() as never,
      orders as never,
    );

    await service.submit(cart({ payment_method: 'qr' }));

    expect(orders.create.mock.calls[0][0].paymentMethod).toBe('qr');
  });

  it('el canal whatsapp rechaza payment_method=cash (regla real de Central, no una copia local)', async () => {
    const orders = fakeOrders();
    const service = new MenuOrderService(
      fakeDb([{ id: 'prod-1', code: 'trancapecho' }]) as never,
      fakeSessionRepo(validSession) as never,
      fakeCustomers() as never,
      orders as never,
    );

    await expect(service.submit(cart({ payment_method: 'cash' }))).rejects.toMatchObject({
      status: 400,
    });
    expect(orders.create).not.toHaveBeenCalled();
  });

  it('delivery y pickup se traducen correctamente al deliveryType de CreateOrderDto', async () => {
    const orders = fakeOrders();
    const service = new MenuOrderService(
      fakeDb([{ id: 'prod-1', code: 'trancapecho' }]) as never,
      fakeSessionRepo(validSession) as never,
      fakeCustomers() as never,
      orders as never,
    );

    await service.submit(cart({ delivery_type: 'pickup' }));
    expect(orders.create.mock.calls[0][0].deliveryType).toBe('pickup');

    await service.submit(cart({ delivery_type: 'delivery' }));
    expect(orders.create.mock.calls[1][0].deliveryType).toBe('delivery');
  });

  it('un producto con código desconocido se rechaza ANTES de llamar a OrdersService', async () => {
    const orders = fakeOrders();
    const service = new MenuOrderService(
      fakeDb([]) as never, // ningún código resuelve
      fakeSessionRepo(validSession) as never,
      fakeCustomers() as never,
      orders as never,
    );

    await expect(service.submit(cart())).rejects.toMatchObject({ status: 400 });
    expect(orders.create).not.toHaveBeenCalled();
  });

  it('promociones: se traducen con su revision intacta para que OrdersService la valide', async () => {
    const orders = fakeOrders();
    const service = new MenuOrderService(
      fakeDb([{ id: 'prod-1', code: 'trancapecho' }]) as never,
      fakeSessionRepo(validSession) as never,
      fakeCustomers() as never,
      orders as never,
    );

    await service.submit(
      cart({ promotions: [{ promotion_id: 'promo-1', quantity: 1, revision: 3 }] }),
    );

    expect(orders.create.mock.calls[0][0].promotions).toEqual([
      { promotionId: 'promo-1', quantity: 1, revision: 3 },
    ]);
  });

  it('retry (misma sesión, mismo carrito) reusa la MISMA idempotency key: no duplica pedido', async () => {
    const orders = fakeOrders();
    const service = new MenuOrderService(
      fakeDb([{ id: 'prod-1', code: 'trancapecho' }]) as never,
      fakeSessionRepo(validSession) as never,
      fakeCustomers() as never,
      orders as never,
    );

    await service.submit(cart());
    await service.submit(cart());

    const [firstKey] = orders.create.mock.calls[0].slice(1);
    const [secondKey] = orders.create.mock.calls[1].slice(1);
    // La deduplicación real (mismo hash de contenido -> misma respuesta) la
    // garantiza IdempotencyService, ya cubierto en su propio spec; acá se
    // comprueba la parte que nos toca: la MISMA sesión siempre produce la
    // MISMA idempotency key, sin importar cuántas veces se reenvíe el carrito.
    expect(firstKey).toBe(secondKey);
    expect(firstKey).toBe('session-1');
  });
});

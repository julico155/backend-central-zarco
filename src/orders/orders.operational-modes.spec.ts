import { DomainException, StoreClosedError } from '../common/exceptions/domain-exception';
import { OrdersService } from './orders.service';
import { QueueWaitingError } from '../order-queue/order-queue.service';

/**
 * Reglas que el admin mueve desde el POS (cerrado, efectivo, promociones, "seguimos atendiendo", cola). Aplican a
 * los canales de cliente (whatsapp/web); el mostrador (pos) no se frena nunca.
 */

// Reloj fijo a las 12:00 de La Paz (16:00 UTC): con el margen 0→23 está adentro, y con 0→0 ('siempre cerrado') afuera,
// sin depender de a qué hora corra el test.
beforeAll(() => {
  jest.useFakeTimers({ now: new Date('2026-11-13T16:00:00Z') });
});
afterAll(() => {
  jest.useRealTimers();
});

const OPEN_ALL_DAY = { business_opens_hour: 0, business_closes_hour: 23 };
const ALWAYS_CLOSED = { business_opens_hour: 0, business_closes_hour: 0 };

const baseDto = {
  customerName: 'Tester',
  deliveryType: 'pickup' as const,
  paymentMethod: 'qr' as const,
  items: [{ productId: 'p1', quantity: 1 }],
  customerId: 'customer-1',
};

function createService(opts: {
  settings?: Record<string, unknown>;
  queue?: { assertCanOrder?: jest.Mock; markUsed?: jest.Mock };
  cashOpen?: boolean;
}) {
  const idempotency = {
    run: jest.fn().mockResolvedValue({ created: true, body: { id: 'order-1', customerId: null }, status: 201 }),
  };
  const operationalSettings = {
    getRow: jest.fn().mockResolvedValue({ ...OPEN_ALL_DAY, ...(opts.settings ?? {}) }),
  };
  const cashRegister = { isOpen: jest.fn().mockResolvedValue(opts.cashOpen ?? true) };
  const queue = {
    assertCanOrder: opts.queue?.assertCanOrder ?? jest.fn().mockResolvedValue(undefined),
    markUsed: opts.queue?.markUsed ?? jest.fn().mockResolvedValue(undefined),
  };
  const service = new OrdersService(
    {} as never,
    idempotency as never,
    operationalSettings as never,
    {} as never,
    {} as never,
    cashRegister as never,
    {} as never,
    { get: jest.fn().mockReturnValue([]) } as never,
    {} as never,
    queue as never,
  );
  // notifyOrderCreated lee la BD; no es lo que se prueba acá.
  jest.spyOn(service, 'notifyOrderCreated').mockResolvedValue(undefined);
  return { service, idempotency, queue };
}

describe('OrdersService.create — modos operativos', () => {
  it('"Cerrado" frena WhatsApp con el mensaje que escribió el admin', async () => {
    const { service, idempotency } = createService({
      settings: { manually_closed: true, closed_message: 'Hoy no abrimos.' },
    });

    const error = await service
      .create({ ...baseDto, channel: 'whatsapp' }, 'k1', 'whatsapp-gateway')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StoreClosedError);
    expect((error as StoreClosedError).message).toBe('Hoy no abrimos.');
    expect(idempotency.run).not.toHaveBeenCalled();
  });

  it('"Cerrado" no frena al mostrador', async () => {
    const { service } = createService({ settings: { manually_closed: true } });
    const result = await service.create({ ...baseDto, channel: 'pos', bypassHoursGate: true }, 'k1', 'pos');
    expect(result.httpStatus).toBe(201);
  });

  it('efectivo apagado: rechaza efectivo de WhatsApp, deja pasar QR y no toca al mostrador', async () => {
    const settings = { cash_enabled: false };

    const blocked = createService({ settings });
    const error = await blocked.service
      .create({ ...baseDto, channel: 'whatsapp', paymentMethod: 'cash' }, 'k1', 'whatsapp-gateway')
      .catch((e: unknown) => e);
    expect((error as DomainException).code).toBe('cash_disabled');

    const qr = createService({ settings });
    await expect(
      qr.service.create({ ...baseDto, channel: 'whatsapp', paymentMethod: 'qr' }, 'k1', 'whatsapp-gateway'),
    ).resolves.toMatchObject({ httpStatus: 201 });

    const pos = createService({ settings });
    await expect(
      pos.service.create({ ...baseDto, channel: 'pos', paymentMethod: 'cash', bypassHoursGate: true }, 'k1', 'pos'),
    ).resolves.toMatchObject({ httpStatus: 201 });
  });

  it('promoción + productos sueltos: bloqueado cuando la regla está en "no combinar"', async () => {
    const { service } = createService({ settings: { allow_promo_with_items: false } });
    const dto = { ...baseDto, channel: 'whatsapp' as const, promotions: [{ promotionId: 'promo', revision: 1, quantity: 1 }] };

    const error = await service.create(dto as never, 'k1', 'whatsapp-gateway').catch((e: unknown) => e);
    expect((error as DomainException).code).toBe('promo_mix_not_allowed');
  });

  it('promoción sola, o productos solos, pasan aunque la regla sea "no combinar"', async () => {
    const settings = { allow_promo_with_items: false };
    const onlyPromo = createService({ settings });
    await expect(
      onlyPromo.service.create(
        { ...baseDto, items: [], channel: 'whatsapp', promotions: [{ promotionId: 'promo', revision: 1, quantity: 1 }] } as never,
        'k1',
        'whatsapp-gateway',
      ),
    ).resolves.toMatchObject({ httpStatus: 201 });

    const onlyItems = createService({ settings });
    await expect(
      onlyItems.service.create({ ...baseDto, channel: 'whatsapp' }, 'k1', 'whatsapp-gateway'),
    ).resolves.toMatchObject({ httpStatus: 201 });
  });

  it('con la regla en "combinar" (la de siempre) se mezclan sin problema', async () => {
    const { service } = createService({ settings: { allow_promo_with_items: true } });
    await expect(
      service.create(
        { ...baseDto, channel: 'whatsapp', promotions: [{ promotionId: 'promo', revision: 1, quantity: 1 }] } as never,
        'k1',
        'whatsapp-gateway',
      ),
    ).resolves.toMatchObject({ httpStatus: 201 });
  });

  it('"Seguimos atendiendo": fuera del margen horario sigue tomando pedidos si la caja está abierta', async () => {
    const closed = createService({ settings: ALWAYS_CLOSED });
    await expect(
      closed.service.create({ ...baseDto, channel: 'whatsapp' }, 'k1', 'whatsapp-gateway'),
    ).rejects.toBeInstanceOf(StoreClosedError);

    const extended = createService({ settings: { ...ALWAYS_CLOSED, extended_service_enabled: true } });
    await expect(
      extended.service.create({ ...baseDto, channel: 'whatsapp' }, 'k1', 'whatsapp-gateway'),
    ).resolves.toMatchObject({ httpStatus: 201 });
  });

  it('"Seguimos atendiendo" con la caja cerrada encola para revisión en vez de tomar el pedido directo', async () => {
    const { service, idempotency } = createService({
      settings: { ...ALWAYS_CLOSED, extended_service_enabled: true },
      cashOpen: false,
    });
    // La solicitud tardía hace sus propias consultas a BD; alcanza con comprobar que NO se creó el pedido normal.
    await service.create({ ...baseDto, channel: 'whatsapp' }, 'k1', 'whatsapp-gateway').catch(() => undefined);
    expect(idempotency.run).not.toHaveBeenCalled();
  });
});

describe('OrdersService.create — cola de pedidos', () => {
  it('si la cola dice que espere, el pedido no se crea', async () => {
    const assertCanOrder = jest.fn().mockRejectedValue(new QueueWaitingError());
    const { service, idempotency } = createService({ queue: { assertCanOrder } });

    await expect(service.create({ ...baseDto, channel: 'whatsapp' }, 'k1', 'whatsapp-gateway')).rejects.toBeInstanceOf(
      QueueWaitingError,
    );
    expect(assertCanOrder).toHaveBeenCalledWith('customer-1', 'whatsapp');
    expect(idempotency.run).not.toHaveBeenCalled();
  });

  it('al crearse el pedido, el cupo reservado del cliente se marca como usado', async () => {
    const { service, queue } = createService({});
    await service.create({ ...baseDto, channel: 'whatsapp' }, 'k1', 'whatsapp-gateway');
    expect(queue.markUsed).toHaveBeenCalledWith('customer-1');
  });

  it('el mostrador no pasa por la cola', async () => {
    const { service, queue } = createService({});
    await service.create({ ...baseDto, channel: 'pos', bypassHoursGate: true }, 'k1', 'pos');
    expect(queue.assertCanOrder).not.toHaveBeenCalled();
    expect(queue.markUsed).not.toHaveBeenCalled();
  });
});

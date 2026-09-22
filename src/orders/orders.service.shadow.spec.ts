import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, Transaction } from 'kysely';
import { AppConfig } from '../config/configuration';
import { Database } from '../database/types';
import { DeliveryService } from '../delivery/delivery.service';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { NotificationsOutService } from '../notifications-out/notifications-out.service';
import { OperationalSettingsService } from '../operational-settings/operational-settings.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderResponse, OrdersService } from './orders.service';

const SHADOW_CLIENT = 'whatsapp-gateway';
const PRODUCT_ID = '08856059-3cd2-4beb-aab7-62ba1cd7eb63';

// 23:30 en Bolivia (UTC-4). Con las horas de `settings` de abajo cae dentro de
// la ventana late_review, sin depender de a qué hora corra el test.
const LATE_REVIEW_INSTANT = new Date('2026-09-17T03:30:00.000Z');
const OPEN_INSTANT = new Date('2026-09-16T20:00:00.000Z'); // 16:00 en Bolivia

function orderResponse(overrides: Partial<OrderResponse> = {}): OrderResponse {
  return {
    id: 'order-1',
    orderNumber: 'A-0001',
    customerId: 'customer-1',
    channel: 'whatsapp',
    customerName: 'Yoan',
    deliveryType: 'pickup',
    paymentMethod: 'cash',
    paymentStatus: 'unpaid',
    status: 'draft',
    notes: null,
    subtotalAmount: 25,
    deliveryBaseAmount: 0,
    deliverySurchargeAmount: 0,
    totalAmount: 25,
    deliveryQuoteStatus: null,
    deliveryDistanceMeters: null,
    cashConfirmedAt: null,
    statusUpdatedBy: null,
    createdAt: new Date().toISOString(),
    items: [],
    promotions: [],
    ...overrides,
  };
}

function baseDto(overrides: Partial<CreateOrderDto> = {}): CreateOrderDto {
  return {
    customerId: 'customer-1',
    channel: 'whatsapp',
    customerName: 'Yoan',
    deliveryType: 'pickup',
    paymentMethod: 'cash',
    items: [{ productId: PRODUCT_ID, quantity: 1 }],
    ...overrides,
  } as CreateOrderDto;
}

/**
 * Kysely de mentira con las dos cadenas que usa `createLateOrderRequest`: el
 * lookup del carrito (late_order_requests vacío, products con La Fija) y el
 * insert de la solicitud. Alcanza para que el camino late_review corra entero
 * sin Postgres.
 */
function fakeDb(
  insertedLateRequest: Record<string, unknown>,
  insertInto: jest.Mock,
): Kysely<Database> {
  const rowsByTable: Record<string, unknown[]> = {
    late_order_requests: [],
    products: [{ id: PRODUCT_ID, price: '25.00', name: 'La Fija', code: 'la_fija' }],
    promotions: [],
  };

  const selectChain = (rows: unknown[]): unknown => {
    const chain = {
      selectAll: () => chain,
      select: () => chain,
      where: () => chain,
      execute: async () => rows,
      executeTakeFirst: async () => rows[0],
      executeTakeFirstOrThrow: async () => rows[0],
    };
    return chain;
  };

  const insertChain = (): unknown => {
    const chain = {
      values: () => chain,
      onConflict: () => chain,
      returningAll: () => chain,
      returning: () => chain,
      execute: async () => [],
      executeTakeFirst: async () => insertedLateRequest,
    };
    return chain;
  };

  return {
    selectFrom: (table: string) => selectChain(rowsByTable[table] ?? []),
    insertInto: (table: string) => {
      insertInto(table);
      return insertChain();
    },
  } as unknown as Kysely<Database>;
}

interface Harness {
  service: OrdersService;
  notifyNow: jest.Mock;
  createInTransaction: jest.SpyInstance;
  /** Llamado con el nombre de tabla en cada `db.insertInto(...)`. */
  insertInto: jest.Mock;
}

function buildService(allowedApiClients: string[] = [SHADOW_CLIENT]): Harness {
  const notifyNow = jest.fn().mockResolvedValue(undefined);
  const insertInto = jest.fn();

  // `run` corre el callback con una transacción falsa: el camino que importa
  // acá es el de después del insert (avisos), no el SQL.
  const idempotency = {
    run: async (params: {
      execute: (trx: Transaction<Database>) => Promise<{ status: number; body: OrderResponse }>;
    }) => {
      const result = await params.execute({} as Transaction<Database>);
      return { body: result.body, status: result.status, created: true };
    },
  } as unknown as IdempotencyService;

  const operationalSettings = {
    getRow: async () => ({
      business_opens_hour: 10,
      business_closes_hour: 23, // -> lateReviewHour
      late_review_closes_hour: 24, // -> closesHour
    }),
  } as unknown as OperationalSettingsService;

  const config = {
    get: () => ({ apiClients: allowedApiClients }),
  } as unknown as ConfigService<AppConfig, true>;

  const service = new OrdersService(
    fakeDb(
      {
        id: 'late-1',
        request_number: 'L-0001',
        customer_name: 'Yoan',
        subtotal_amount: '25.00',
        expires_at: new Date('2026-09-17T03:40:00.000Z'),
      },
      insertInto,
    ),
    idempotency,
    operationalSettings,
    {} as DeliveryService,
    { notifyNow } as unknown as NotificationsOutService,
    config,
  );

  // El pedido devuelto refleja el carrito de entrada: `paymentMethod` y
  // `customerId` son justo lo que decide qué avisos salen.
  const createInTransaction = jest
    .spyOn(service, 'createOrderInTransaction')
    .mockImplementation(async (_trx, input) =>
      orderResponse({ paymentMethod: input.paymentMethod, customerId: input.customerId }),
    );

  return { service, notifyNow, createInTransaction, insertInto };
}

function kindsSent(notifyNow: jest.Mock): string[] {
  return notifyNow.mock.calls.map(([job]) => job.kind);
}

function atOpenHours(): void {
  jest.useFakeTimers({ doNotFake: ['nextTick'] }).setSystemTime(OPEN_INSTANT);
}

function atLateReviewHours(): void {
  jest.useFakeTimers({ doNotFake: ['nextTick'] }).setSystemTime(LATE_REVIEW_INSTANT);
}

describe('OrdersService — suppressNotifications (pedidos en modo sombra)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('sin el flag, el comportamiento queda exactamente igual', () => {
    it('un pedido normal sigue mandando order_received', async () => {
      atOpenHours();
      const { service, notifyNow } = buildService();

      const outcome = await service.create(baseDto(), 'key-1', SHADOW_CLIENT, 'service');

      expect(outcome.httpStatus).toBe(201);
      expect(kindsSent(notifyNow)).toEqual(['order_received']);
    });

    it('un pedido con QR sigue mandando order_received y qr_confirmation', async () => {
      atOpenHours();
      const { service, notifyNow } = buildService();

      await service.create(baseDto({ paymentMethod: 'qr' }), 'key-2', SHADOW_CLIENT, 'service');

      expect(kindsSent(notifyNow)).toEqual(['order_received', 'qr_confirmation']);
    });

    it('una solicitud fuera de horario se sigue insertando y alertando al mostrador', async () => {
      atLateReviewHours();
      const { service, notifyNow, insertInto } = buildService();

      const outcome = await service.create(baseDto(), 'key-3', SHADOW_CLIENT, 'service');

      expect(outcome.httpStatus).toBe(202);
      expect(outcome.body).toEqual(
        expect.objectContaining({ requestId: 'late-1', requestNumber: 'L-0001' }),
      );
      expect(insertInto).toHaveBeenCalledWith('late_order_requests');
      expect(kindsSent(notifyNow)).toEqual(['late_request_alert']);
    });

    // `suppressNotifications: false` no es "modo sombra apagado a medias":
    // tiene que ser indistinguible de no mandar el campo, y ni siquiera debe
    // consultar la allowlist.
    it('suppressNotifications: false se comporta como no mandarlo', async () => {
      atOpenHours();
      const { service, notifyNow } = buildService([]);

      const outcome = await service.create(
        baseDto({ suppressNotifications: false }),
        'key-4',
        SHADOW_CLIENT,
        'service',
      );

      expect(outcome.httpStatus).toBe(201);
      expect(kindsSent(notifyNow)).toEqual(['order_received']);
    });
  });

  describe('con el flag, se crea todo pero no sale ningún aviso', () => {
    it('pedido no-QR: cero llamadas a notifyNow', async () => {
      atOpenHours();
      const { service, notifyNow, createInTransaction } = buildService();

      const outcome = await service.create(
        baseDto({ suppressNotifications: true }),
        'key-5',
        SHADOW_CLIENT,
        'service',
      );

      expect(outcome.httpStatus).toBe(201);
      expect(createInTransaction).toHaveBeenCalledTimes(1);
      expect(outcome.body).toEqual(expect.objectContaining({ id: 'order-1', totalAmount: 25 }));
      expect(notifyNow).not.toHaveBeenCalled();
    });

    // El caso que se escapaba antes: qr_confirmation es un mensaje real de
    // WhatsApp al cliente, no un placeholder interno.
    it('pedido con QR: cero llamadas a notifyNow', async () => {
      atOpenHours();
      const { service, notifyNow, createInTransaction } = buildService();

      const outcome = await service.create(
        baseDto({ paymentMethod: 'qr', suppressNotifications: true }),
        'key-6',
        SHADOW_CLIENT,
        'service',
      );

      expect(outcome.httpStatus).toBe(201);
      expect(createInTransaction).toHaveBeenCalledTimes(1);
      expect(notifyNow).not.toHaveBeenCalled();
    });

    // En late_review el endpoint no crea un pedido sino una late_order_request,
    // cuya aceptación/rechazo dispara después `late_request_decision` desde
    // LateOrderRequestsService. Como la supresión no se persiste en la fila, un
    // pedido sombra ahí sería silencioso al crearse y ruidoso horas más tarde.
    // Por ahora se rechaza de plano.
    it('en late_review: 409, sin insertar la solicitud ni alertar', async () => {
      atLateReviewHours();
      const { service, notifyNow, insertInto } = buildService();

      await expect(
        service.create(
          baseDto({ suppressNotifications: true }),
          'key-7',
          SHADOW_CLIENT,
          'service',
        ),
      ).rejects.toMatchObject({ code: 'shadow_late_review_not_supported' });

      expect(insertInto).not.toHaveBeenCalled();
      expect(notifyNow).not.toHaveBeenCalled();
    });

    it('el 409 de late_review en sombra viaja como error de dominio', async () => {
      atLateReviewHours();
      const { service } = buildService();

      await expect(
        service.create(
          baseDto({ suppressNotifications: true }),
          'key-13',
          SHADOW_CLIENT,
          'service',
        ),
      ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });

    // `NotificationsOutService.notifyNow` encola en notification_jobs ANTES de
    // despachar: si el modo sombra solo evitara el envío, la fila quedaría
    // 'pending' y NotificationRecoveryCron escribiría igual un minuto después.
    // Por eso se intercepta antes del servicio, no dentro.
    it('no queda ningún job que el cron de recuperación pueda reintentar', async () => {
      atOpenHours();
      const { service, notifyNow } = buildService();

      await service.create(
        baseDto({ paymentMethod: 'qr', suppressNotifications: true }),
        'key-8',
        SHADOW_CLIENT,
        'service',
      );

      expect(notifyNow.mock.calls).toHaveLength(0);
    });
  });

  describe('autorización', () => {
    it('rechaza con 403 a un api_client de servicio fuera de la allowlist, sin crear nada', async () => {
      atOpenHours();
      const { service, notifyNow, createInTransaction } = buildService([SHADOW_CLIENT]);

      await expect(
        service.create(baseDto({ suppressNotifications: true }), 'key-9', 'pos', 'service'),
      ).rejects.toMatchObject({ code: 'notification_suppression_not_allowed' });

      expect(createInTransaction).not.toHaveBeenCalled();
      expect(notifyNow).not.toHaveBeenCalled();
    });

    it('rechaza a una sesión de staff aunque su api_client esté en la allowlist', async () => {
      atOpenHours();
      const { service, createInTransaction } = buildService(['pos']);

      await expect(
        service.create(baseDto({ suppressNotifications: true }), 'key-10', 'pos', 'staff'),
      ).rejects.toMatchObject({ code: 'notification_suppression_not_allowed' });

      expect(createInTransaction).not.toHaveBeenCalled();
    });

    it('rechaza a todos cuando la allowlist está vacía (default de producción)', async () => {
      atOpenHours();
      const { service } = buildService([]);

      await expect(
        service.create(
          baseDto({ suppressNotifications: true }),
          'key-11',
          SHADOW_CLIENT,
          'service',
        ),
      ).rejects.toMatchObject({ code: 'notification_suppression_not_allowed' });
    });

    // El chequeo va antes del gate de horario: en late_review tampoco puede
    // crearse la solicitud y alertar igual.
    it('rechaza en late_review sin crear la solicitud ni alertar', async () => {
      atLateReviewHours();
      const { service, notifyNow, insertInto } = buildService([]);

      await expect(
        service.create(
          baseDto({ suppressNotifications: true }),
          'key-12',
          SHADOW_CLIENT,
          'service',
        ),
      ).rejects.toMatchObject({ code: 'notification_suppression_not_allowed' });

      expect(insertInto).not.toHaveBeenCalled();
      expect(notifyNow).not.toHaveBeenCalled();
    });
  });
});

import { ConfigService } from '@nestjs/config';
import { Kysely } from 'kysely';
import { Database } from '../../database/types';
import { signSmarkyPayload } from './smarky-signature';
import { SmarkyWebhookService } from './smarky-webhook.service';

const SECRETO = 'secreto-de-prueba';
const AHORA = 1_800_000_000_000;
const ID_PEDIDO = '11111111-1111-4111-8111-111111111111';
const ID_ENTREGA = '22222222-2222-4222-8222-222222222222';
const ID_EVENTO = '33333333-3333-4333-8333-333333333333';

function evento(status: string, eventId = ID_EVENTO, externalOrderId = ID_PEDIDO) {
  return Buffer.from(
    JSON.stringify({
      eventId,
      type: 'entrega.recogida',
      occurredAt: '2026-11-07T12:00:00Z',
      delivery: {
        deliveryId: ID_ENTREGA,
        externalOrderId,
        status,
        fee: '7.00',
        trackingUrl: 'https://seguimiento.test/seguir/abc',
      },
    }),
  );
}

function firmar(body: Buffer, secret = SECRETO, t = AHORA / 1000) {
  return `t=${t},v1=${signSmarkyPayload(secret, t, body)}`;
}

function crearServicio(opciones: { pedido?: { status: string; smarky_delivery_status: string | null } | null } = {}) {
  const pedido = opciones.pedido === undefined ? { status: 'preparing', smarky_delivery_status: 'assigned' } : opciones.pedido;
  const vistos = new Set<string>();
  const actualizaciones: Array<Record<string, unknown>> = [];

  const trx: Record<string, unknown> = {};
  trx.insertInto = () => {
    const builder: Record<string, unknown> = {};
    let valores: { event_id: string } | undefined;
    builder.values = (v: { event_id: string }) => {
      valores = v;
      return builder;
    };
    builder.onConflict = () => builder;
    builder.returning = () => builder;
    builder.executeTakeFirst = async () => {
      if (!valores || vistos.has(valores.event_id)) return undefined;
      vistos.add(valores.event_id);
      return { event_id: valores.event_id };
    };
    return builder;
  };
  trx.selectFrom = () => {
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.where = () => builder;
    builder.forUpdate = () => builder;
    builder.executeTakeFirstOrThrow = async () => pedido;
    return builder;
  };
  trx.updateTable = () => {
    const builder: Record<string, unknown> = {};
    builder.set = (v: Record<string, unknown>) => {
      actualizaciones.push(v);
      return builder;
    };
    builder.where = () => builder;
    builder.execute = async () => [];
    return builder;
  };

  const db = {
    selectFrom: () => {
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.where = () => builder;
      builder.executeTakeFirst = async () => (pedido ? { id: ID_PEDIDO, order_number: 'ORD-261107-276', customer_name: 'Ana', ...pedido } : undefined);
      return builder;
    },
    transaction: () => ({ execute: async (fn: (t: unknown) => unknown) => fn(trx) }),
  } as unknown as Kysely<Database>;

  const config = {
    get: () => ({ provider: 'smarky', smarky: { baseUrl: 'https://x', apiKey: 'k', webhookSecret: SECRETO } }),
  } as unknown as ConfigService<never, true>;

  const notifyNow = jest.fn().mockResolvedValue(undefined);
  return { service: new SmarkyWebhookService(db, config as never, { notifyNow } as never), actualizaciones, notifyNow };
}

describe('SmarkyWebhookService', () => {
  it('rechaza con 401 una firma inválida y no toca nada', async () => {
    const { service, actualizaciones } = crearServicio();
    const body = evento('in_transit');
    await expect(service.handle(body, firmar(body, 'otro-secreto'), AHORA)).rejects.toMatchObject({
      status: 401,
    });
    await expect(service.handle(body, undefined, AHORA)).rejects.toMatchObject({ status: 401 });
    expect(actualizaciones).toHaveLength(0);
  });

  it('rechaza con 401 una firma válida pero vieja (más de 5 minutos)', async () => {
    const { service } = crearServicio();
    const body = evento('in_transit');
    await expect(service.handle(body, firmar(body, SECRETO, AHORA / 1000 - 400), AHORA)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('un evento in_transit firmado pasa el pedido a out_for_delivery y guarda el estado de la entrega', async () => {
    const { service, actualizaciones } = crearServicio();
    const body = evento('in_transit');
    await expect(service.handle(body, firmar(body), AHORA)).resolves.toBe('processed');

    expect(actualizaciones).toHaveLength(1);
    expect(actualizaciones[0]).toMatchObject({
      smarky_delivery_id: ID_ENTREGA,
      smarky_delivery_status: 'in_transit',
      smarky_tracking_url: 'https://seguimiento.test/seguir/abc',
      status: 'out_for_delivery',
      status_updated_by: 'smarky',
      delivery_driver_name: 'Plataforma de reparto',
    });
  });

  it('ignora un eventId ya procesado (idempotencia)', async () => {
    const { service, actualizaciones } = crearServicio();
    const body = evento('delivered');
    await expect(service.handle(body, firmar(body), AHORA)).resolves.toBe('processed');
    await expect(service.handle(body, firmar(body), AHORA)).resolves.toBe('duplicate');
    expect(actualizaciones).toHaveLength(1);
  });

  it('un evento asignada actualiza el estado de la entrega sin mover el pedido', async () => {
    const { service, actualizaciones } = crearServicio();
    const body = evento('assigned');
    await service.handle(body, firmar(body), AHORA);
    expect(actualizaciones[0]).toMatchObject({ smarky_delivery_status: 'assigned' });
    expect(actualizaciones[0]).not.toHaveProperty('status');
  });

  it('un evento rezagado no pisa un estado final de la entrega', async () => {
    const { service, actualizaciones } = crearServicio({
      pedido: { status: 'delivered', smarky_delivery_status: 'delivered' },
    });
    const body = evento('in_transit');
    await expect(service.handle(body, firmar(body), AHORA)).resolves.toBe('processed');
    expect(actualizaciones[0]).not.toHaveProperty('smarky_delivery_status');
    expect(actualizaciones[0]).not.toHaveProperty('status');
  });

  it('responde unknown_order (2xx) si no hay pedido para la entrega', async () => {
    const { service, actualizaciones } = crearServicio({ pedido: null });
    const body = evento('in_transit');
    await expect(service.handle(body, firmar(body), AHORA)).resolves.toBe('unknown_order');
    expect(actualizaciones).toHaveLength(0);
  });

  it('rechaza con 400 un cuerpo firmado pero con formato inesperado', async () => {
    const { service } = crearServicio();
    const body = Buffer.from(JSON.stringify({ eventId: 'no-es-uuid' }));
    await expect(service.handle(body, firmar(body), AHORA)).rejects.toMatchObject({ status: 400 });
  });
});

describe('SmarkyWebhookService — entrega abandonada y entregada', () => {
  it('delivered mueve el pedido a delivered y marca delivered_at', async () => {
    const { service, actualizaciones } = crearServicio({
      pedido: { status: 'out_for_delivery', smarky_delivery_status: 'in_transit' },
    });
    const body = evento('delivered');
    await service.handle(body, firmar(body), AHORA);
    expect(actualizaciones[0]).toMatchObject({ status: 'delivered', smarky_delivery_status: 'delivered' });
    expect(actualizaciones[0].delivered_at).toBeInstanceOf(Date);
  });

  it('failed NO cancela el pedido pagado: guarda el estado y avisa al grupo propio', async () => {
    const { service, actualizaciones, notifyNow } = crearServicio();
    const body = evento('failed');
    await expect(service.handle(body, firmar(body), AHORA)).resolves.toBe('processed');
    expect(actualizaciones[0]).toMatchObject({ smarky_delivery_status: 'failed' });
    expect(actualizaciones[0]).not.toHaveProperty('status');
    expect(notifyNow).toHaveBeenCalledTimes(1);
    expect(notifyNow).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'telegram',
        kind: 'smarky_delivery_abandoned',
        targetRef: ID_PEDIDO,
        payload: expect.objectContaining({ chatRef: 'delivery-group' }),
      }),
    );
  });

  it('cancelled tampoco cancela el pedido y avisa una sola vez', async () => {
    const { service, actualizaciones, notifyNow } = crearServicio();
    const body = evento('cancelled');
    await service.handle(body, firmar(body), AHORA);
    expect(actualizaciones[0]).not.toHaveProperty('status');
    expect(notifyNow).toHaveBeenCalledTimes(1);
  });

  it('si la entrega ya estaba abandonada, no se avisa de nuevo', async () => {
    const { service, notifyNow } = crearServicio({ pedido: { status: 'ready', smarky_delivery_status: 'failed' } });
    const body = evento('cancelled');
    await service.handle(body, firmar(body), AHORA);
    expect(notifyNow).not.toHaveBeenCalled();
  });

  it('un fallo al avisar al grupo no rompe el webhook', async () => {
    const { service, notifyNow } = crearServicio();
    notifyNow.mockRejectedValue(new Error('telegram caído'));
    const body = evento('failed');
    await expect(service.handle(body, firmar(body), AHORA)).resolves.toBe('processed');
  });
});

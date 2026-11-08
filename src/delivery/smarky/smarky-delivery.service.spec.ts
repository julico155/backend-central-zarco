import { ConsoleLogger, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely } from 'kysely';
import { Database } from '../../database/types';
import { SmarkyApiError, SmarkyClient } from './smarky-client';
import { SmarkyDeliveryService } from './smarky-delivery.service';
import { buildTrackingMessage, toE164 } from './smarky-messages';

const ID_PEDIDO = '11111111-1111-4111-8111-111111111111';

const pedidoListo = {
  id: ID_PEDIDO,
  order_number: 'ORD-261107-276',
  customer_id: 'c1',
  customer_name: 'Ana',
  delivery_type: 'delivery',
  delivery_quote_status: 'quoted',
  status: 'confirmed',
  payment_status: 'paid',
  payment_method: 'qr',
  delivery_latitude: -17.78,
  delivery_longitude: -63.18,
  smarky_delivery_id: null,
  smarky_delivery_status: null,
};

function crear(opciones: {
  pedido?: Record<string, unknown>;
  telefono?: string | null;
  reclamoGanado?: boolean;
  client?: Partial<Record<'createQuote' | 'createDelivery' | 'reissueCode', jest.Mock>> | null;
  enviar?: jest.Mock;
  proveedor?: 'smarky' | 'internal';
}) {
  const actualizaciones: Array<Record<string, unknown>> = [];
  const db = {
    selectFrom: (tabla: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.selectAll = () => b;
      b.where = () => b;
      b.executeTakeFirst = async () =>
        tabla === 'orders'
          ? { ...pedidoListo, ...opciones.pedido }
          : { phone: opciones.telefono === undefined ? '59171234567' : opciones.telefono };
      return b;
    },
    updateTable: () => {
      const b: Record<string, unknown> = {};
      b.set = (v: Record<string, unknown>) => {
        actualizaciones.push(v);
        return b;
      };
      b.where = () => b;
      b.returning = () => b;
      b.executeTakeFirst = async () => (opciones.reclamoGanado === false ? undefined : { id: ID_PEDIDO });
      b.execute = async () => [];
      return b;
    },
  } as unknown as Kysely<Database>;

  const config = {
    get: () => ({
      provider: opciones.proveedor ?? 'smarky',
      smarky: { baseUrl: 'https://x', apiKey: 'k', webhookSecret: 's' },
    }),
  } as unknown as ConfigService<never, true>;

  const enviar = opciones.enviar ?? jest.fn().mockResolvedValue({ externalMessageId: 'm1' });
  const gateway = { sendWhatsappMessage: enviar };
  const notifyNow = jest.fn().mockResolvedValue(undefined);

  const client =
    opciones.client === null
      ? null
      : ({
          createQuote: jest.fn().mockResolvedValue({ quoteId: 'q1' }),
          createDelivery: jest.fn().mockResolvedValue({
            deliveryId: 'd1',
            externalOrderId: ID_PEDIDO,
            status: 'searching',
            fee: '7.00',
            trackingUrl: 'https://seguimiento.test/seguir/abc',
            deliveryCode: '4821',
          }),
          reissueCode: jest.fn().mockResolvedValue('9999'),
          ...opciones.client,
        } as unknown as SmarkyClient);

  const service = new SmarkyDeliveryService(db, config as never, gateway as never, { notifyNow } as never, client);
  return { service, actualizaciones, enviar, notifyNow, client: client as unknown as Record<string, jest.Mock> };
}

describe('SmarkyDeliveryService.dispatchForOrder', () => {
  it('con proveedor interno no hace nada: ni plataforma ni WhatsApp', async () => {
    const { service, client, enviar } = crear({ proveedor: 'internal' });
    expect(service.enabled).toBe(false);
    await expect(service.dispatchForOrder(ID_PEDIDO)).resolves.toBe('skipped');
    expect(client.createQuote).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
  });

  it('con smarky pero sin credenciales (cliente nulo) queda apagado', async () => {
    const { service } = crear({ client: null });
    expect(service.enabled).toBe(false);
    await expect(service.dispatchForOrder(ID_PEDIDO)).resolves.toBe('skipped');
  });

  it('cotiza con el pin, pide la entrega con el id del pedido y manda link + código en un solo WhatsApp de texto', async () => {
    const { service, client, enviar, actualizaciones } = crear({});
    await expect(service.dispatchForOrder(ID_PEDIDO)).resolves.toBe('dispatched');

    expect(client.createQuote).toHaveBeenCalledWith({ latitude: -17.78, longitude: -63.18 });
    expect(client.createDelivery).toHaveBeenCalledWith({
      externalOrderId: ID_PEDIDO,
      quoteId: 'q1',
      customer: { name: 'Ana', phone: '+59171234567' },
      prepEtaMinutes: 20,
      orderLabel: 'ORD-276',
    });
    expect(enviar).toHaveBeenCalledTimes(1);
    const mensaje = enviar.mock.calls[0][0] as { customerId: string; text: string; messageType?: string };
    expect(mensaje.customerId).toBe('c1');
    expect(mensaje.messageType).toBeUndefined();
    expect(mensaje.text).toContain('https://seguimiento.test/seguir/abc');
    expect(mensaje.text).toContain('4821');

    // El código no se guarda: lo persistido es solo id, link y estado.
    const guardado = actualizaciones.find((u) => 'smarky_delivery_id' in u);
    expect(guardado).toMatchObject({ smarky_delivery_id: 'd1', smarky_delivery_status: 'searching' });
    expect(JSON.stringify(actualizaciones)).not.toContain('4821');
  });

  it('el efectivo ya cotizado también pide repartidor (no espera cobro)', async () => {
    const { service, client } = crear({ pedido: { payment_method: 'cash', payment_status: 'unpaid' } });
    await expect(service.dispatchForOrder(ID_PEDIDO)).resolves.toBe('dispatched');
    expect(client.createQuote).toHaveBeenCalled();
  });

  it('no escribe el código en los logs', async () => {
    const mensajes: string[] = [];
    const captura = (message: unknown) => mensajes.push(String(message));
    Logger.overrideLogger({ log: captura, warn: captura, error: captura, debug: captura, verbose: captura });
    try {
      const { service } = crear({ enviar: jest.fn().mockRejectedValue(new Error('gateway caído')) });
      await service.dispatchForOrder(ID_PEDIDO);
    } finally {
      Logger.overrideLogger(new ConsoleLogger());
    }
    expect(mensajes.length).toBeGreaterThan(0);
    expect(mensajes.join(' | ')).not.toMatch(/4821|9999/);
  });

  it('si el WhatsApp falla, reemite un código nuevo y reintenta una vez', async () => {
    const enviar = jest
      .fn()
      .mockRejectedValueOnce(new Error('gateway caído'))
      .mockResolvedValueOnce({ externalMessageId: 'm2' });
    const { service, client } = crear({ enviar });
    await expect(service.dispatchForOrder(ID_PEDIDO)).resolves.toBe('dispatched');

    expect(client.reissueCode).toHaveBeenCalledWith('d1');
    expect((enviar.mock.calls[1][0] as { text: string }).text).toContain('9999');
    expect((enviar.mock.calls[1][0] as { text: string }).text).not.toContain('4821');
  });

  it('si el envío directo falla dos veces, el link sale por la cola SIN código y la entrega sigue como pedida', async () => {
    const { service, notifyNow } = crear({ enviar: jest.fn().mockRejectedValue(new Error('caído')) });
    await expect(service.dispatchForOrder(ID_PEDIDO)).resolves.toBe('dispatched');
    expect(notifyNow).toHaveBeenCalledTimes(1);
    const job = notifyNow.mock.calls[0][0] as { kind: string; targetRef: string; payload: { text: string } };
    expect(job.kind).toBe('delivery_tracking');
    expect(job.targetRef).toBe(ID_PEDIDO);
    expect(job.payload.text).toContain('https://seguimiento.test/seguir/abc');
    expect(JSON.stringify(job)).not.toMatch(/4821|9999/);
  });

  it('si la entrega ya existía y no trae código, lo reemite para mandárselo al cliente', async () => {
    const { service, client, enviar } = crear({
      client: {
        createDelivery: jest.fn().mockResolvedValue({
          deliveryId: 'd1',
          externalOrderId: ID_PEDIDO,
          status: 'searching',
          fee: '7.00',
          trackingUrl: 'https://seguimiento.test/seguir/abc',
        }),
      },
    });
    await service.dispatchForOrder(ID_PEDIDO);
    expect(client.reissueCode).toHaveBeenCalledTimes(1);
    expect((enviar.mock.calls[0][0] as { text: string }).text).toContain('9999');
  });

  it('recotiza una vez si la cotización venció', async () => {
    const createDelivery = jest
      .fn()
      .mockRejectedValueOnce(new SmarkyApiError(409, 'quote_expired', 'vencida'))
      .mockResolvedValueOnce({
        deliveryId: 'd1',
        externalOrderId: ID_PEDIDO,
        status: 'searching',
        fee: '7.00',
        trackingUrl: 'u',
        deliveryCode: '4821',
      });
    const createQuote = jest.fn().mockResolvedValueOnce({ quoteId: 'q1' }).mockResolvedValueOnce({ quoteId: 'q2' });
    const { service } = crear({ client: { createDelivery, createQuote } });
    await expect(service.dispatchForOrder(ID_PEDIDO)).resolves.toBe('dispatched');
    expect(createQuote).toHaveBeenCalledTimes(2);
    expect((createDelivery.mock.calls[1][0] as { quoteId: string }).quoteId).toBe('q2');
  });

  it('out_of_coverage: devuelve failed (cae al flujo propio), libera el reclamo y no manda WhatsApp', async () => {
    const { service, enviar, actualizaciones } = crear({
      client: { createQuote: jest.fn().mockRejectedValue(new SmarkyApiError(422, 'out_of_coverage', 'fuera')) },
    });
    await expect(service.dispatchForOrder(ID_PEDIDO)).resolves.toBe('failed');
    expect(enviar).not.toHaveBeenCalled();
    expect(actualizaciones).toContainEqual({ smarky_delivery_status: null });
  });

  it('un error inesperado nunca lanza: failed y el pedido sigue por el flujo propio', async () => {
    const { service } = crear({ client: { createQuote: jest.fn().mockRejectedValue(new TypeError('boom')) } });
    await expect(service.dispatchForOrder(ID_PEDIDO)).resolves.toBe('failed');
  });

  it('teléfono inválido: failed sin llamar a la plataforma', async () => {
    const { service, client } = crear({ telefono: '123' });
    await expect(service.dispatchForOrder(ID_PEDIDO)).resolves.toBe('failed');
    expect(client.createQuote).not.toHaveBeenCalled();
  });

  it('no pide repartidor si el pedido QR no está pagado', async () => {
    const { service, client } = crear({ pedido: { payment_status: 'unpaid' } });
    await expect(service.dispatchForOrder(ID_PEDIDO)).resolves.toBe('skipped');
    expect(client.createQuote).not.toHaveBeenCalled();
  });

  it('si ya tiene entrega en curso devuelve in_progress; si la plataforma la abandonó, vuelve al flujo propio', async () => {
    const enCurso = crear({ pedido: { smarky_delivery_id: 'd1', smarky_delivery_status: 'assigned' } });
    await expect(enCurso.service.dispatchForOrder(ID_PEDIDO)).resolves.toBe('in_progress');

    const abandonada = crear({ pedido: { smarky_delivery_id: 'd1', smarky_delivery_status: 'failed' } });
    await expect(abandonada.service.dispatchForOrder(ID_PEDIDO)).resolves.toBe('skipped');
    expect(abandonada.client.createQuote).not.toHaveBeenCalled();
  });

  it('si otro proceso ganó el reclamo no pide una segunda entrega', async () => {
    const carrera = crear({ reclamoGanado: false });
    await expect(carrera.service.dispatchForOrder(ID_PEDIDO)).resolves.toBe('in_progress');
    expect(carrera.client.createQuote).not.toHaveBeenCalled();
    expect(carrera.enviar).not.toHaveBeenCalled();
  });

  it('no pide repartidor para retiro en el local, mesa ni pedidos cancelados', async () => {
    for (const pedido of [{ delivery_type: 'pickup' }, { delivery_type: 'dine_in' }, { status: 'cancelled' }]) {
      const caso = crear({ pedido });
      await expect(caso.service.dispatchForOrder(ID_PEDIDO)).resolves.toBe('skipped');
      expect(caso.client.createQuote).not.toHaveBeenCalled();
    }
  });
});

describe('mensaje de seguimiento', () => {
  it('lleva el link y el código cuando hay código', () => {
    const texto = buildTrackingMessage({ orderNumber: 'ORD-276', trackingUrl: 'https://s.test/seguir/x', deliveryCode: '4821' });
    expect(texto.startsWith('¡Listo! Tenemos tu pedido ORD-276 confirmado')).toBe(true);
    expect(texto).toContain('ORD-276');
    expect(texto).toContain('https://s.test/seguir/x');
    expect(texto).toContain('Código de entrega: 4821');
  });

  it('sin código solo lleva el link', () => {
    const texto = buildTrackingMessage({ orderNumber: 'ORD-276', trackingUrl: 'https://s.test/seguir/x', deliveryCode: null });
    expect(texto).not.toContain('Código');
  });

  it('normaliza el teléfono a E.164 y descarta los inválidos', () => {
    expect(toE164('59171234567')).toBe('+59171234567');
    expect(toE164('+591 7123-4567')).toBe('+59171234567');
    expect(toE164('123')).toBeNull();
    expect(toE164(null)).toBeNull();
  });
});

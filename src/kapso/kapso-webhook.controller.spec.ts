import { createHmac } from 'node:crypto';
import { KapsoWebhookController } from './kapso-webhook.controller';

const secret = 'test-webhook-secret';
const headers = {
  signature: '',
  version: 'v2',
  event: 'whatsapp.message.received',
  eventId: 'event-test-1',
};

function response() {
  return { status: jest.fn().mockReturnThis() };
}

function createController(
  asyncAck = false,
  accept = jest.fn().mockResolvedValue({ kind: 'accepted', id: 'row-id' }),
) {
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'kapso') return { webhookSecret: secret };
      if (key === 'webhookAsyncAck') return asyncAck;
      return undefined;
    }),
  };
  const inbox = { accept, processById: jest.fn().mockResolvedValue('processed') };
  return { controller: new KapsoWebhookController(config as never, inbox as never), inbox };
}

describe('KapsoWebhookController', () => {
  const raw = Buffer.from(
    JSON.stringify({ message: { id: 'wamid.1', type: 'text', text: { body: 'hola' } } }),
  );

  beforeEach(() => {
    headers.signature = createHmac('sha256', secret).update(raw).digest('hex');
  });

  it('rejects invalid signatures before inbox persistence', async () => {
    const { controller, inbox } = createController();
    const res = response();
    const body = await controller.receive(
      { rawBody: raw } as never,
      res as never,
      'bad',
      headers.version,
      headers.event,
      headers.eventId,
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(body).toEqual({ error: 'invalid_signature' });
    expect(inbox.accept).not.toHaveBeenCalled();
  });

  it('persists then processes an inline durable ACK', async () => {
    const { controller, inbox } = createController(false);
    const body = await controller.receive(
      { rawBody: raw } as never,
      response() as never,
      headers.signature,
      headers.version,
      headers.event,
      headers.eventId,
    );
    expect(inbox.accept).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: headers.eventId, messageId: 'wamid.1' }),
    );
    expect(inbox.processById).toHaveBeenCalledWith('row-id');
    expect(body).toEqual({ ok: true, accepted: true });
  });

  it('returns the durable ACK before asynchronous processing', async () => {
    const { controller, inbox } = createController(true);
    const body = await controller.receive(
      { rawBody: raw } as never,
      response() as never,
      headers.signature,
      headers.version,
      headers.event,
      headers.eventId,
    );
    expect(inbox.accept).toHaveBeenCalledTimes(1);
    expect(body).toEqual({ ok: true, accepted: true });
  });

  it('acknowledges a known duplicate without processing it again', async () => {
    const { controller, inbox } = createController(
      false,
      jest.fn().mockResolvedValue({ kind: 'duplicate' }),
    );
    const body = await controller.receive(
      { rawBody: raw } as never,
      response() as never,
      headers.signature,
      headers.version,
      headers.event,
      headers.eventId,
    );
    expect(body).toEqual({ ok: true, duplicate: true });
    expect(inbox.processById).not.toHaveBeenCalled();
  });

  it('rejects a malformed batch before checking whether the event is accepted', async () => {
    const { controller, inbox } = createController();
    const malformedBatch = Buffer.from(JSON.stringify({ batch: true, data: [] }));
    const signature = createHmac('sha256', secret).update(malformedBatch).digest('hex');
    const res = response();
    const body = await controller.receive(
      { rawBody: malformedBatch } as never,
      res as never,
      signature,
      headers.version,
      'whatsapp.message.unknown',
      headers.eventId,
    );
    expect(res.status).toHaveBeenCalledWith(422);
    expect(body).toEqual({ ok: false, error: 'unsupported_batch', reason: 'batch_data_empty' });
    expect(inbox.accept).not.toHaveBeenCalled();
  });

  it('ignores an unsupported event before requiring an idempotency key', async () => {
    const { controller, inbox } = createController();
    const res = response();
    const body = await controller.receive(
      { rawBody: raw } as never,
      res as never,
      headers.signature,
      headers.version,
      'whatsapp.message.unknown',
      undefined,
    );
    expect(body).toEqual({ ok: true, ignored: true });
    expect(inbox.accept).not.toHaveBeenCalled();
  });

  it('accepts the four outbound events Sarco reconciles instead of ignoring them', async () => {
    const { controller, inbox } = createController(false);
    const outboundRaw = Buffer.from(
      JSON.stringify({ message: { id: 'wamid.outbound', type: 'text' } }),
    );
    const outboundSignature = createHmac('sha256', secret).update(outboundRaw).digest('hex');
    const body = await controller.receive(
      { rawBody: outboundRaw } as never,
      response() as never,
      outboundSignature,
      headers.version,
      'whatsapp.message.sent',
      headers.eventId,
    );
    expect(inbox.accept).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'whatsapp.message.sent', messageId: 'wamid.outbound' }),
    );
    expect(body).toEqual({ ok: true, accepted: true });
  });
});

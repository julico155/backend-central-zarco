import { WebhookInboxDispatcher } from './webhook-inbox.dispatcher';
import type { NormalizedKapsoEvent } from '../kapso/kapso.types';

function event(overrides: Partial<NormalizedKapsoEvent> = {}): NormalizedKapsoEvent {
  return {
    eventName: 'whatsapp.message.received',
    eventId: 'event-1',
    envelopeIndex: 0,
    messageId: 'wamid.1',
    customerPhone: '59170000000',
    conversationId: null,
    phoneNumberId: 'phone-1',
    contentType: 'text',
    text: 'hola',
    image: null,
    audio: null,
    location: null,
    interactive: null,
    ...overrides,
  };
}

describe('WebhookInboxDispatcher', () => {
  it('un whatsapp.message.received se despacha a handleInboundBatch con los eventos normalizados', async () => {
    const agent = { handleInboundBatch: jest.fn(), handleOutboundEvent: jest.fn() };
    const dispatcher = new WebhookInboxDispatcher(agent as never);
    const events = [event()];

    await dispatcher.dispatch({
      id: 'row-1',
      eventId: 'event-1',
      eventName: 'whatsapp.message.received',
      payload: { message: { id: 'wamid.1' } },
      normalizedEvents: events,
    });

    expect(agent.handleInboundBatch).toHaveBeenCalledWith(events);
    expect(agent.handleOutboundEvent).not.toHaveBeenCalled();
  });

  it('cada uno de los cuatro eventos salientes se despacha a handleOutboundEvent', async () => {
    const agent = { handleInboundBatch: jest.fn(), handleOutboundEvent: jest.fn() };
    const dispatcher = new WebhookInboxDispatcher(agent as never);

    for (const eventName of [
      'whatsapp.message.sent',
      'whatsapp.message.delivered',
      'whatsapp.message.read',
      'whatsapp.message.failed',
    ]) {
      const payload = { message: { id: 'wamid.out' } };
      const events = [event({ eventName })];
      await dispatcher.dispatch({
        id: 'row-1',
        eventId: 'event-1',
        eventName,
        payload,
        normalizedEvents: events,
      });
      expect(agent.handleOutboundEvent).toHaveBeenCalledWith(eventName, payload, events);
    }
    expect(agent.handleInboundBatch).not.toHaveBeenCalled();
  });

  it('un evento no reconocido no llama a ninguno de los dos métodos', async () => {
    const agent = { handleInboundBatch: jest.fn(), handleOutboundEvent: jest.fn() };
    const dispatcher = new WebhookInboxDispatcher(agent as never);

    await dispatcher.dispatch({
      id: 'row-1',
      eventId: 'event-1',
      eventName: 'whatsapp.message.unknown',
      payload: {},
      normalizedEvents: [],
    });

    expect(agent.handleInboundBatch).not.toHaveBeenCalled();
    expect(agent.handleOutboundEvent).not.toHaveBeenCalled();
  });
});

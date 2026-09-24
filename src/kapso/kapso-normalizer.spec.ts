import { normalizeKapsoPayload, parseKapsoEnvelopes } from './kapso-normalizer';

const eventName = 'whatsapp.message.received';

function normalize(message: Record<string, unknown>) {
  return normalizeKapsoPayload(
    JSON.stringify({
      phone_number_id: 'phone-number-id',
      conversation: { id: 'conversation-id', phone_number: '+591 70000000' },
      message,
    }),
    eventName,
    'event-id',
  );
}

describe('normalizeKapsoPayload', () => {
  it('normalizes text', () => {
    const result = normalize({ id: 'wamid.text', type: 'text', text: { body: 'hola' } });
    expect(result).toMatchObject({
      ok: true,
      events: [{ contentType: 'text', text: 'hola', customerPhone: '59170000000' }],
    });
  });

  it('normalizes image references without downloading media', () => {
    const result = normalize({
      id: 'wamid.image',
      type: 'image',
      image: { id: 'image-id', link: 'https://app.kapso.ai/media/a', caption: 'comprobante' },
      kapso: { media_data: { content_type: 'image/jpeg' } },
    });
    expect(result).toMatchObject({
      ok: true,
      events: [
        {
          contentType: 'image',
          image: { id: 'image-id', mimeType: 'image/jpeg', caption: 'comprobante' },
        },
      ],
    });
  });

  it('normalizes audio references without treating them as text', () => {
    const result = normalize({
      id: 'wamid.audio',
      type: 'audio',
      audio: { id: 'audio-id', url: 'https://app.kapso.ai/media/a' },
      kapso: { media_data: { content_type: 'audio/ogg' } },
    });
    expect(result).toMatchObject({
      ok: true,
      events: [
        { contentType: 'audio', text: null, audio: { id: 'audio-id', mimeType: 'audio/ogg' } },
      ],
    });
  });

  it('normalizes native location', () => {
    const result = normalize({
      id: 'wamid.location',
      type: 'location',
      location: { latitude: -17.78, longitude: -63.18, name: 'Casa', address: 'Calle 1' },
    });
    expect(result).toMatchObject({
      ok: true,
      events: [
        {
          contentType: 'location',
          location: { latitude: -17.78, longitude: -63.18, name: 'Casa' },
        },
      ],
    });
  });

  it('normalizes interactive button/list identifiers', () => {
    const result = normalize({
      id: 'wamid.interactive',
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: 'cash-confirm', title: 'CONFIRMO' },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      events: [
        {
          contentType: 'interactive',
          interactive: { type: 'button_reply', id: 'cash-confirm', title: 'CONFIRMO' },
        },
      ],
    });
  });

  it('keeps the source batch contract, including batch_info', () => {
    const result = normalizeKapsoPayload(
      JSON.stringify({ batch: true, data: [] }),
      eventName,
      'event-id',
    );
    expect(result).toEqual({
      ok: false,
      status: 422,
      error: 'unsupported_batch',
      reason: 'batch_data_empty',
    });
  });

  it('rejects a batch without batch_info like Sarco', () => {
    const result = normalizeKapsoPayload(
      JSON.stringify({
        batch: true,
        data: [{ message: { id: 'wamid.batch', type: 'text', text: { body: 'hola' } } }],
      }),
      eventName,
      'event-id',
    );
    expect(result).toMatchObject({ ok: false, reason: 'batch_missing_batch_info' });
  });

  it('rejects a batch of an outbound event as unsupported, like Sarco', () => {
    const result = normalizeKapsoPayload(
      JSON.stringify({
        batch: true,
        data: [{ message: { id: 'wamid.out', type: 'text', text: { body: 'hola' } } }],
        batch_info: { size: 1 },
      }),
      'whatsapp.message.sent',
      'event-id',
    );
    expect(result).toEqual({
      ok: false,
      status: 422,
      error: 'unsupported_batch',
      reason: 'batch_unsupported_event',
    });
  });

  it('reports structural batch errors before the event-specific rejection, like Sarco', () => {
    // A malformed batch is rejected on its own shape, regardless of which
    // event name it claims to carry.
    const result = parseKapsoEnvelopes(JSON.stringify({ batch: true, data: [] }));
    expect(result).toEqual({
      ok: false,
      status: 422,
      error: 'unsupported_batch',
      reason: 'batch_data_empty',
    });
  });

  it('normalizes the four outbound events Sarco reconciles', () => {
    const result = normalizeKapsoPayload(
      JSON.stringify({
        phone_number_id: 'phone-number-id',
        message: {
          id: 'wamid.sent',
          to: '+591 70000000',
          text: { body: 'Tu pedido #123 fue confirmado' },
          kapso: { whatsapp_conversation_id: 'wa-conv-id' },
        },
      }),
      'whatsapp.message.sent',
      'event-id',
    );
    expect(result).toMatchObject({
      ok: true,
      events: [
        {
          eventName: 'whatsapp.message.sent',
          messageId: 'wamid.sent',
          customerPhone: '59170000000',
          conversationId: 'wa-conv-id',
          phoneNumberId: 'phone-number-id',
          contentType: 'text',
          text: 'Tu pedido #123 fue confirmado',
        },
      ],
    });
  });
});

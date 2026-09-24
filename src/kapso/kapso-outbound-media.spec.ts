import { KapsoOutboundService } from './kapso-outbound.service';

function fakeConfig(overrides: Partial<{ apiKey: string; phoneNumberId: string }> = {}) {
  const kapso = {
    apiKey: 'test-key',
    phoneNumberId: 'default-phone',
    apiBaseUrl: 'https://api.kapso.ai/meta/whatsapp/v24.0',
    ...overrides,
  };
  return { get: () => kapso } as never;
}

function jsonFetch(body: unknown, ok = true, status = 200) {
  return jest.fn().mockResolvedValue({ ok, status, json: async () => body });
}

describe('KapsoOutboundService — ubicación, subida de imagen y envío por media id', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sendLocationRequest: payload EXACTO de sarcoRestaurant (buildLocationRequestPayload): texto con instrucciones, sin botón nativo', async () => {
    // Paridad verificada contra sarcoRestaurant/src/lib/kapso/messages.ts: el
    // interactive.location_request_message (botón send_location) se quitó el
    // 03-09-2026 porque atascaba el último paso; hoy Sarco manda TEXTO plano.
    global.fetch = jsonFetch({ messages: [{ id: 'wamid.loc' }] }) as never;

    const result = await new KapsoOutboundService(fakeConfig()).sendLocationRequest(
      '+591 700-00000',
      'phone-x',
    );

    expect(result).toEqual({ ok: true, wamid: 'wamid.loc' });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.kapso.ai/meta/whatsapp/v24.0/phone-x/messages');
    expect(init.headers['X-API-Key']).toBe('test-key');
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '59170000000',
      type: 'text',
      text: {
        body:
          'Por favor comparte tu ubicación actual para coordinar el delivery.\n\n' +
          'Toca el clip 📎 → Ubicación → ENVIAR UBICACIÓN ACTUAL',
      },
    });
    expect(init.body).not.toMatch(/interactive|location_request_message|send_location/);
  });

  it('uploadImage sube por multipart a /{phone_number_id}/media y devuelve el media id', async () => {
    global.fetch = jsonFetch({ id: 'media-123' }) as never;

    const result = await new KapsoOutboundService(fakeConfig()).uploadImage(
      Buffer.from([1, 2, 3]),
      'image/png',
    );

    expect(result).toEqual({ ok: true, mediaId: 'media-123' });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.kapso.ai/meta/whatsapp/v24.0/default-phone/media');
    expect(init.method).toBe('POST');
    expect(init.headers['X-API-Key']).toBe('test-key');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('type')).toBe('image');
  });

  it('uploadImage rechaza bytes vacíos o tipos que no son png/jpeg sin tocar la red', async () => {
    global.fetch = jsonFetch({ id: 'x' }) as never;
    const service = new KapsoOutboundService(fakeConfig());

    await expect(service.uploadImage(Buffer.alloc(0), 'image/png')).resolves.toEqual({
      ok: false,
      error: 'invalid_media',
    });
    await expect(service.uploadImage(Buffer.from([1]), 'application/pdf')).resolves.toEqual({
      ok: false,
      error: 'invalid_media',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('uploadImage sin credenciales → not_configured; HTTP error / respuesta inválida son tipados', async () => {
    global.fetch = jsonFetch({ id: 'x' }) as never;
    await expect(
      new KapsoOutboundService(fakeConfig({ apiKey: '' })).uploadImage(
        Buffer.from([1]),
        'image/png',
      ),
    ).resolves.toEqual({ ok: false, error: 'not_configured' });

    global.fetch = jsonFetch({}, false, 502) as never;
    await expect(
      new KapsoOutboundService(fakeConfig()).uploadImage(Buffer.from([1]), 'image/png'),
    ).resolves.toEqual({ ok: false, error: 'http_error', status: 502 });

    global.fetch = jsonFetch({ nope: true }) as never;
    await expect(
      new KapsoOutboundService(fakeConfig()).uploadImage(Buffer.from([1]), 'image/png'),
    ).resolves.toEqual({ ok: false, error: 'invalid_response' });
  });

  it('sendImageByMediaId manda la imagen por id con caption opcional', async () => {
    global.fetch = jsonFetch({ messages: [{ id: 'wamid.img' }] }) as never;
    const service = new KapsoOutboundService(fakeConfig());

    await expect(
      service.sendImageByMediaId('+591 700 00000', 'media-1', 'Escaneá'),
    ).resolves.toEqual({
      ok: true,
      wamid: 'wamid.img',
    });
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '59170000000',
      type: 'image',
      image: { id: 'media-1', caption: 'Escaneá' },
    });

    await service.sendImageByMediaId('59170000000', 'media-1');
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body).image).toEqual({
      id: 'media-1',
    });
  });

  it('sendImageByMediaId valida teléfono y media id', async () => {
    global.fetch = jsonFetch({ messages: [{ id: 'x' }] }) as never;
    const service = new KapsoOutboundService(fakeConfig());
    await expect(service.sendImageByMediaId('abc', 'm')).resolves.toEqual({
      ok: false,
      error: 'invalid_phone',
    });
    await expect(service.sendImageByMediaId('59170000000', '  ')).resolves.toEqual({
      ok: false,
      error: 'invalid_media',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

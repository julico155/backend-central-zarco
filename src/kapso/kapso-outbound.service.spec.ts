import { KapsoOutboundService } from './kapso-outbound.service';

function fakeConfig(
  overrides: Partial<{ apiKey: string; phoneNumberId: string; apiBaseUrl: string }> = {},
) {
  const kapso = {
    apiKey: 'test-key',
    phoneNumberId: 'default-phone',
    apiBaseUrl: 'https://api.kapso.ai/meta/whatsapp/v24.0',
    ...overrides,
  };
  return { get: () => kapso } as never;
}

function mockFetch(response: { ok: boolean; status?: number; json?: () => Promise<unknown> }) {
  return jest.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: response.json ?? (async () => ({})),
  });
}

describe('KapsoOutboundService', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sendText postea el payload de texto correcto y devuelve el wamid', async () => {
    global.fetch = mockFetch({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.out.1' }] }),
    }) as never;
    const service = new KapsoOutboundService(fakeConfig());

    const result = await service.sendText('+591 700 00000', 'Hola!', 'phone-x');

    expect(result).toEqual({ ok: true, wamid: 'wamid.out.1' });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.kapso.ai/meta/whatsapp/v24.0/phone-x/messages');
    expect(init.headers['X-API-Key']).toBe('test-key');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '59170000000',
      type: 'text',
      text: { body: 'Hola!' },
    });
  });

  it('sendMenuCtaUrl manda el CTA interactivo cta_url con header/body/botón', async () => {
    global.fetch = mockFetch({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.cta.1' }] }),
    }) as never;
    const service = new KapsoOutboundService(fakeConfig());

    const result = await service.sendMenuCtaUrl({
      customerPhone: '59170000000',
      phoneNumberId: 'phone-x',
      menuUrl: 'https://menu.example.com/menu?session=abc',
      coverImageUrl: 'https://cdn.example.com/cover.jpg',
      bodyText: 'Tocá el botón para ver el menú.',
      buttonText: 'Ver menú',
    });

    expect(result).toEqual({ ok: true, wamid: 'wamid.cta.1' });
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '59170000000',
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        header: { type: 'image', image: { link: 'https://cdn.example.com/cover.jpg' } },
        body: { text: 'Tocá el botón para ver el menú.' },
        action: {
          name: 'cta_url',
          parameters: {
            display_text: 'Ver menú',
            url: 'https://menu.example.com/menu?session=abc',
          },
        },
      },
    });
  });

  it('sendMenuCtaUrl sin menuUrl ni coverImageUrl rechaza sin llamar a fetch', async () => {
    const fetchMock = mockFetch({ ok: true });
    global.fetch = fetchMock as never;
    const service = new KapsoOutboundService(fakeConfig());

    const result = await service.sendMenuCtaUrl({
      customerPhone: '59170000000',
      menuUrl: '',
      coverImageUrl: '',
      bodyText: 'hola',
      buttonText: 'Ver menú',
    });

    expect(result).toEqual({ ok: false, error: 'invalid_url' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sin KAPSO_API_KEY, not_configured sin llamar a fetch (nunca red real)', async () => {
    const fetchMock = mockFetch({ ok: true });
    global.fetch = fetchMock as never;
    const service = new KapsoOutboundService(fakeConfig({ apiKey: '' }));

    const result = await service.sendText('59170000000', 'hola');

    expect(result).toEqual({ ok: false, error: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un 4xx del proveedor se reporta como http_error con el status', async () => {
    global.fetch = mockFetch({ ok: false, status: 401 }) as never;
    const service = new KapsoOutboundService(fakeConfig());

    const result = await service.sendText('59170000000', 'hola');

    expect(result).toEqual({ ok: false, error: 'http_error', status: 401 });
  });
});

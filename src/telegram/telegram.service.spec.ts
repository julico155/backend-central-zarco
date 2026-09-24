import { TelegramService } from './telegram.service';

function fakeConfig(
  overrides: Partial<{
    botToken: string;
    chatId: string;
    handoffChatId: string;
    apiBaseUrl: string;
  }> = {},
) {
  const telegram = {
    botToken: 'BOT:TOKEN',
    chatId: '-1001',
    handoffChatId: '',
    apiBaseUrl: '',
    ...overrides,
  };
  return { get: () => telegram } as never;
}

function okFetch(messageId: unknown = 77) {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: messageId } }),
  });
}

describe('TelegramService (transporte directo, fetch falso)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sendMessage: endpoint, chat_id, texto, parse_mode HTML y disable_web_page_preview', async () => {
    global.fetch = okFetch() as never;
    const service = new TelegramService(fakeConfig());

    const result = await service.send({
      chatRef: 'delivery-group',
      text: '<b>hola</b>',
      parseMode: 'HTML',
    });

    expect(result).toEqual({ ok: true, messageId: '77' });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botBOT:TOKEN/sendMessage');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({
      chat_id: '-1001',
      text: '<b>hola</b>',
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  });

  it('sin parseMode no manda parse_mode (texto plano)', async () => {
    global.fetch = okFetch() as never;
    await new TelegramService(fakeConfig()).send({ chatRef: 'staff-group', text: 'plano' });
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).not.toHaveProperty('parse_mode');
  });

  it('staff-group y delivery-group van al mismo chat (TELEGRAM_CHAT_ID)', async () => {
    global.fetch = okFetch() as never;
    const service = new TelegramService(fakeConfig({ handoffChatId: '-2002' }));
    await service.send({ chatRef: 'staff-group', text: 'a' });
    await service.send({ chatRef: 'delivery-group', text: 'b' });
    const chats = (global.fetch as jest.Mock).mock.calls.map(
      ([, init]) => JSON.parse(init.body).chat_id,
    );
    expect(chats).toEqual(['-1001', '-1001']);
  });

  it('handoff-group usa TELEGRAM_HANDOFF_CHAT_ID, NO el grupo de motos', async () => {
    global.fetch = okFetch() as never;
    await new TelegramService(fakeConfig({ handoffChatId: '-2002' })).send({
      chatRef: 'handoff-group',
      text: 'atención',
    });
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).chat_id).toBe('-2002');
  });

  it('handoff-group sin chat propio cae al chat de siempre', async () => {
    global.fetch = okFetch() as never;
    await new TelegramService(fakeConfig()).send({ chatRef: 'handoff-group', text: 'atención' });
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).chat_id).toBe('-1001');
  });

  it('editMessageId usa editMessageText con message_id numérico', async () => {
    global.fetch = okFetch() as never;
    await new TelegramService(fakeConfig()).send({
      chatRef: 'delivery-group',
      text: 'nuevo',
      editMessageId: '55',
    });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toMatch(/\/editMessageText$/);
    expect(JSON.parse(init.body).message_id).toBe(55);
  });

  it('chatRef desconocido, texto vacío o demasiado largo: no toca la red', async () => {
    global.fetch = okFetch() as never;
    const service = new TelegramService(fakeConfig());
    await expect(service.send({ chatRef: 'otro', text: 'x' })).resolves.toEqual({
      ok: false,
      error: 'unknown_chat',
    });
    await expect(service.send({ chatRef: 'delivery-group', text: '   ' })).resolves.toEqual({
      ok: false,
      error: 'invalid_text',
    });
    await expect(
      service.send({ chatRef: 'delivery-group', text: 'x'.repeat(4097) }),
    ).resolves.toEqual({ ok: false, error: 'invalid_text' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sin token o sin chat → not_configured, sin red', async () => {
    global.fetch = okFetch() as never;
    await expect(
      new TelegramService(fakeConfig({ botToken: '' })).send({
        chatRef: 'delivery-group',
        text: 'x',
      }),
    ).resolves.toEqual({ ok: false, error: 'not_configured' });
    await expect(
      new TelegramService(fakeConfig({ chatId: '' })).send({
        chatRef: 'delivery-group',
        text: 'x',
      }),
    ).resolves.toEqual({ ok: false, error: 'not_configured' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('HTTP no-2xx → http_error con status, sin exponer token ni cuerpo', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }) as never;
    const result = await new TelegramService(fakeConfig()).send({
      chatRef: 'delivery-group',
      text: 'x',
    });
    expect(result).toEqual({ ok: false, error: 'http_error', status: 429 });
    expect(JSON.stringify(result)).not.toContain('BOT:TOKEN');
  });

  it.each([[{ ok: true }], [{ ok: true, result: { message_id: 'x' } }], [{ ok: false }]])(
    'respuesta sin message_id válido → invalid_response (%j)',
    async (body) => {
      global.fetch = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => body }) as never;
      await expect(
        new TelegramService(fakeConfig()).send({ chatRef: 'delivery-group', text: 'x' }),
      ).resolves.toEqual({ ok: false, error: 'invalid_response' });
    },
  );

  it('JSON ilegible → invalid_response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad json');
      },
    }) as never;
    await expect(
      new TelegramService(fakeConfig()).send({ chatRef: 'delivery-group', text: 'x' }),
    ).resolves.toEqual({ ok: false, error: 'invalid_response' });
  });

  it('timeout (AbortError) y red caída son errores tipados, nunca lanzan', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(abort)
      .mockRejectedValueOnce(new Error('ECONNRESET')) as never;
    const service = new TelegramService(fakeConfig());
    await expect(service.send({ chatRef: 'delivery-group', text: 'x' })).resolves.toEqual({
      ok: false,
      error: 'timeout',
    });
    await expect(service.send({ chatRef: 'delivery-group', text: 'x' })).resolves.toEqual({
      ok: false,
      error: 'network_error',
    });
  });

  it('apiBaseUrl configurable (pruebas/proxy)', async () => {
    global.fetch = okFetch() as never;
    await new TelegramService(fakeConfig({ apiBaseUrl: 'http://localhost:9999' })).send({
      chatRef: 'delivery-group',
      text: 'x',
    });
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(
      'http://localhost:9999/botBOT:TOKEN/sendMessage',
    );
  });
});

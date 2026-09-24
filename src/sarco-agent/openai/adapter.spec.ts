import { createOpenAiModel, OPENAI_RESPONSES_URL } from './adapter';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('createOpenAiModel', () => {
  it('no llama a fetch si falta la API key', async () => {
    const fetchImpl = jest.fn();
    const model = createOpenAiModel({ apiKey: '', fetchImpl: fetchImpl as never });
    const result = await model.complete([{ role: 'user', content: 'hola' }]);

    expect(result).toEqual({ ok: false, error: 'not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('llama a la Responses API con Bearer y devuelve el texto', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        model: 'gpt-4o-mini',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hola!' }] }],
      }),
    );
    const model = createOpenAiModel({ apiKey: 'sk-test', fetchImpl: fetchImpl as never });
    const result = await model.complete([{ role: 'user', content: 'hola' }]);

    expect(result).toEqual({ ok: true, text: 'Hola!', model: 'gpt-4o-mini' });
    expect(fetchImpl).toHaveBeenCalledWith(
      OPENAI_RESPONSES_URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer sk-test' }),
      }),
    );
    // Nunca se envía la clave en el cuerpo.
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as { body: string }).body);
    expect(JSON.stringify(body)).not.toContain('sk-test');
  });

  it('extrae function_call como toolCalls, ignorando items desconocidos', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        model: 'gpt-4o-mini',
        output: [
          { type: 'reasoning' },
          { type: 'function_call', call_id: 'call-1', name: 'answer_directly', arguments: '{}' },
        ],
      }),
    );
    const model = createOpenAiModel({ apiKey: 'sk-test', fetchImpl: fetchImpl as never });
    const result = await model.complete([{ role: 'user', content: 'hola' }], {
      tools: [{ name: 'answer_directly', description: 'd', parameters: {} }],
      toolChoice: 'required',
    });

    expect(result).toEqual({
      ok: true,
      text: '',
      model: 'gpt-4o-mini',
      toolCalls: [{ callId: 'call-1', name: 'answer_directly', arguments: '{}' }],
    });
  });

  it('un texto vacío sin herramientas es empty_response, nunca se inventa contenido', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse({ model: 'gpt-4o-mini', output: [] }));
    const model = createOpenAiModel({ apiKey: 'sk-test', fetchImpl: fetchImpl as never });
    const result = await model.complete([{ role: 'user', content: 'hola' }]);

    expect(result).toEqual({ ok: false, error: 'empty_response' });
  });

  it('status incomplete se descarta aunque traiga texto parcial', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        model: 'gpt-4o-mini',
        status: 'incomplete',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'a medias' }] }],
      }),
    );
    const model = createOpenAiModel({ apiKey: 'sk-test', fetchImpl: fetchImpl as never });
    const result = await model.complete([{ role: 'user', content: 'hola' }]);

    expect(result).toEqual({ ok: false, error: 'incomplete_response' });
  });

  it('un 429/500 del proveedor se reporta como http_error con el status', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({}, false, 429));
    const model = createOpenAiModel({ apiKey: 'sk-test', fetchImpl: fetchImpl as never });
    const result = await model.complete([{ role: 'user', content: 'hola' }]);

    expect(result).toEqual({ ok: false, error: 'http_error', status: 429 });
  });

  it('un cuerpo con forma inesperada no revienta: invalid_response', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ output: 'not-an-array' }));
    const model = createOpenAiModel({ apiKey: 'sk-test', fetchImpl: fetchImpl as never });
    const result = await model.complete([{ role: 'user', content: 'hola' }]);

    expect(result).toEqual({ ok: false, error: 'invalid_response' });
  });

  it('un timeout (AbortError) se reporta como timeout, no como network_error', async () => {
    const fetchImpl = jest.fn().mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    const model = createOpenAiModel({ apiKey: 'sk-test', fetchImpl: fetchImpl as never });
    const result = await model.complete([{ role: 'user', content: 'hola' }]);

    expect(result).toEqual({ ok: false, error: 'timeout' });
  });
});

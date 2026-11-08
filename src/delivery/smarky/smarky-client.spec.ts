import { SmarkyApiError, SmarkyClient } from './smarky-client';

function respuesta(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function crearCliente(respuestas: Array<Response | Error>) {
  const fetchFn = jest.fn(async () => {
    const siguiente = respuestas.shift();
    if (!siguiente) throw new Error('sin más respuestas');
    if (siguiente instanceof Error) throw siguiente;
    return siguiente;
  });
  const sleep = jest.fn(async () => undefined);
  const client = new SmarkyClient({
    baseUrl: 'https://plataforma.test',
    apiKey: 'sdk_clave_de_prueba',
    fetchFn: fetchFn as unknown as typeof fetch,
    sleep,
  });
  return { client, fetchFn, sleep };
}

const cotizacion = { quoteId: 'q1', distanceMeters: 1200, fee: '7.00', estimatedMinutes: 8, expiresAt: 'x' };

describe('SmarkyClient', () => {
  it('cotiza con Bearer y el destino en el cuerpo', async () => {
    const { client, fetchFn } = crearCliente([respuesta(201, cotizacion)]);
    const result = await client.createQuote({ latitude: -17.78, longitude: -63.18 });

    expect(result.quoteId).toBe('q1');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://plataforma.test/v1/cotizaciones');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sdk_clave_de_prueba');
    expect(JSON.parse(init.body as string)).toEqual({ destination: { latitude: -17.78, longitude: -63.18 } });
  });

  it('reintenta routing_unavailable y termina con la cotización', async () => {
    const { client, fetchFn, sleep } = crearCliente([
      respuesta(503, { code: 'routing_unavailable', message: 'x', details: null }),
      respuesta(201, cotizacion),
    ]);
    await expect(client.createQuote({ latitude: 1, longitude: 1 })).resolves.toMatchObject({ quoteId: 'q1' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('reintenta errores de red y, agotados los intentos, falla con network_error', async () => {
    const { client, fetchFn } = crearCliente([new Error('a'), new Error('b'), new Error('c')]);
    await expect(client.createQuote({ latitude: 1, longitude: 1 })).rejects.toMatchObject({ code: 'network_error' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('no reintenta respuestas definitivas como out_of_coverage', async () => {
    const { client, fetchFn } = crearCliente([
      respuesta(422, { code: 'out_of_coverage', message: 'fuera', details: { distanceMeters: 9300 } }),
    ]);
    const error = await client.createQuote({ latitude: 1, longitude: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(SmarkyApiError);
    expect(error).toMatchObject({ status: 422, code: 'out_of_coverage', details: { distanceMeters: 9300 } });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('no reintenta tariff_not_configured aunque sea un 503', async () => {
    const { client, fetchFn } = crearCliente([
      respuesta(503, { code: 'tariff_not_configured', message: 'x', details: null }),
    ]);
    await expect(client.createQuote({ latitude: 1, longitude: 1 })).rejects.toMatchObject({
      code: 'tariff_not_configured',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('reemite el código y devuelve solo el código', async () => {
    const { client, fetchFn } = crearCliente([respuesta(200, { deliveryId: 'd1', deliveryCode: '4821' })]);
    await expect(client.reissueCode('d1')).resolves.toBe('4821');
    expect((fetchFn.mock.calls[0] as unknown as [string])[0]).toBe('https://plataforma.test/v1/entregas/d1/codigo');
  });
});

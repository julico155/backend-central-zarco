import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { CreateLogisticsDeliveryRequest } from './logistics-delivery.mapper';
import { LogisticsHttpClientService } from './logistics-http-client.service';

const deliveryId = '11111111-1111-4111-8111-111111111111';
const payload: CreateLogisticsDeliveryRequest = {
  tenantId: 'tenant-a',
  restaurantId: 'restaurant-a',
  branchId: 'branch-a',
  externalOrderId: 'order-a',
  sourceSystem: 'zarco-orders-core',
  pickupAddress: null,
  pickupLatitude: -17.77,
  pickupLongitude: -63.17,
  dropoffAddress: 'Calle 1',
  dropoffLatitude: -17.78,
  dropoffLongitude: -63.18,
  customerName: 'Ana',
  customerPhone: null,
  customerNotes: null,
  deliveryFee: 12,
};

describe('LogisticsHttpClientService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts 201 only with a valid delivery UUID and sends tenant-client headers', async () => {
    const fetchMock = mockFetch(new Response(JSON.stringify({ id: deliveryId }), { status: 201 }));

    await expect(client().createDelivery(payload)).resolves.toEqual({
      kind: 'succeeded',
      deliveryId,
      remoteStatusCode: 201,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://logistics.test/v1/deliveries',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }),
    );
    expect(fetchMock.mock.calls[0][1]?.headers).not.toHaveProperty('X-Tenant-Id');
  });

  it('treats the documented duplicate 409 as idempotent success', async () => {
    mockFetch(
      new Response(JSON.stringify({ code: 'delivery_already_exists', deliveryId }), {
        status: 409,
      }),
    );

    await expect(client().createDelivery(payload)).resolves.toEqual({
      kind: 'succeeded',
      deliveryId,
      remoteStatusCode: 409,
    });
  });

  it('treats malformed and unexpected 2xx responses as permanent contract violations', async () => {
    mockFetch(new Response(JSON.stringify({ id: 'not-a-uuid' }), { status: 201 }));
    await expect(client().createDelivery(payload)).resolves.toMatchObject({
      kind: 'permanent_failure',
      errorCode: 'invalid_success_response',
      remoteStatusCode: 201,
    });

    mockFetch(new Response('', { status: 202 }));
    await expect(client().createDelivery(payload)).resolves.toMatchObject({
      kind: 'permanent_failure',
      errorCode: 'unexpected_success_status',
      remoteStatusCode: 202,
    });
  });

  it('treats an invalid 409 and client errors as permanent failures', async () => {
    mockFetch(new Response(JSON.stringify({ code: 'other_conflict' }), { status: 409 }));
    await expect(client().createDelivery(payload)).resolves.toMatchObject({
      kind: 'permanent_failure',
      errorCode: 'conflict',
      remoteStatusCode: 409,
    });

    mockFetch(new Response('', { status: 400 }));
    await expect(client().createDelivery(payload)).resolves.toMatchObject({
      kind: 'permanent_failure',
      errorCode: 'remote_client_error',
      remoteStatusCode: 400,
    });
  });

  it.each([401, 403, 422])('treats HTTP %i as a permanent failure', async (status) => {
    mockFetch(new Response('', { status }));

    await expect(client().createDelivery(payload)).resolves.toMatchObject({
      kind: 'permanent_failure',
      errorCode: 'remote_client_error',
      remoteStatusCode: status,
    });
  });

  it('classifies 429 with valid Retry-After as retryable', async () => {
    mockFetch(new Response('', { status: 429, headers: { 'Retry-After': '120' } }));

    await expect(client().createDelivery(payload)).resolves.toEqual({
      kind: 'retryable_failure',
      errorCode: 'rate_limited',
      remoteStatusCode: 429,
      retryAfterMs: 120_000,
    });
  });

  it('classifies server, timeout and network failures as retryable', async () => {
    mockFetch(new Response('', { status: 500 }));
    await expect(client().createDelivery(payload)).resolves.toMatchObject({
      kind: 'retryable_failure',
      errorCode: 'remote_server_error',
      remoteStatusCode: 500,
    });

    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('socket closed'));
    await expect(client().createDelivery(payload)).resolves.toMatchObject({
      kind: 'retryable_failure',
      errorCode: 'network_error',
    });

    jest.spyOn(global, 'fetch').mockImplementationOnce(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          (init?.signal as AbortSignal).addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    await expect(client(1).createDelivery(payload)).resolves.toMatchObject({
      kind: 'retryable_failure',
      errorCode: 'timeout',
    });
  });
});

function client(timeout = 5_000): LogisticsHttpClientService {
  return new LogisticsHttpClientService({
    get: () => ({
      enabled: true,
      baseUrl: 'https://logistics.test/',
      apiToken: 'test-token',
      tenantId: 'tenant-a',
      restaurantId: 'restaurant-a',
      branchId: 'branch-a',
      pickupAddress: null,
      requestTimeoutMs: timeout,
    }),
  } as unknown as ConfigService<AppConfig, true>);
}

function mockFetch(response: Response): jest.SpyInstance {
  return jest.spyOn(global, 'fetch').mockResolvedValue(response);
}

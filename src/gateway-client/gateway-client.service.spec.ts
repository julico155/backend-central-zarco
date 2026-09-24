import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { GatewayClientService } from './gateway-client.service';

describe('GatewayClientService timeout', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  function service(timeoutMs = 100) {
    const config = {
      get: jest.fn().mockReturnValue({
        baseUrl: 'https://gateway.test',
        authToken: 'test-token',
        timeoutMs,
      }),
    } as unknown as ConfigService<AppConfig, true>;
    return new GatewayClientService(config);
  }

  it('aborts fetch at the configured timeout and reports a sanitized error', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn(
      (_url, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('abort')));
        }),
    ) as typeof fetch;

    const result = service(100).sendTelegramAlert({ chatRef: 'staff', text: 'test' });
    const rejection = expect(result).rejects.toThrow('Gateway request timed out');
    await jest.advanceTimersByTimeAsync(100);

    await rejection;
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not expose a failed fetch error message', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('https://secret.example/token')) as typeof fetch;

    await expect(service().sendTelegramAlert({ chatRef: 'staff', text: 'test' })).rejects.toThrow(
      'Gateway request failed',
    );
  });
});

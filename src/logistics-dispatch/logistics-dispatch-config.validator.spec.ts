import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { LogisticsDispatchConfigValidator } from './logistics-dispatch-config.validator';

describe('LogisticsDispatchConfigValidator', () => {
  it('does not require Logistics credentials while dispatch is disabled', () => {
    expect(() => validator({ enabled: false }).onModuleInit()).not.toThrow();
  });

  it('requires credentials and a positive integer timeout when dispatch is enabled', () => {
    expect(() => validator({ enabled: true, apiToken: '' }).onModuleInit()).toThrow(
      'LOGISTICS_API_TOKEN',
    );
    expect(() => validator({ enabled: true, requestTimeoutMs: 0 }).onModuleInit()).toThrow(
      'LOGISTICS_REQUEST_TIMEOUT_MS',
    );
  });
});

function validator(
  overrides: Partial<AppConfig['logisticsDispatch']>,
): LogisticsDispatchConfigValidator {
  return new LogisticsDispatchConfigValidator({
    get: () => ({
      enabled: true,
      baseUrl: 'https://logistics.test',
      apiToken: 'test-token',
      tenantId: 'tenant-a',
      restaurantId: 'restaurant-a',
      branchId: 'branch-a',
      pickupAddress: null,
      requestTimeoutMs: 5_000,
      ...overrides,
    }),
  } as unknown as ConfigService<AppConfig, true>);
}

import { Logger } from '@nestjs/common';
import { GatewayClientService } from './gateway-client.service';

describe('GatewayClientService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('logs only technical failure metadata', async () => {
    const config = {
      get: jest.fn().mockReturnValue({ baseUrl: 'https://gateway.example', authToken: 'token-for-test' }),
    };
    const service = new GatewayClientService(config as never);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const sensitiveResponse = 'phone=59170000000 token=provider-secret';
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      headers: new Headers({ 'x-request-id': 'request-123' }),
      text: jest.fn().mockResolvedValue(sensitiveResponse),
    }) as never;

    await expect(service.requestWhatsappLocation({ customerId: 'customer-id' })).rejects.toThrow(
      'Gateway call failed: POST /gateway/whatsapp/location-requests -> 502',
    );

    expect(warn).toHaveBeenCalledWith(
      'Gateway call failed: POST /gateway/whatsapp/location-requests -> 502 requestId=request-123',
    );
    expect(String(warn.mock.calls[0][0])).not.toContain(sensitiveResponse);
  });
});

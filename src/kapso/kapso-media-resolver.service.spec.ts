import { KapsoMediaResolverService } from './kapso-media-resolver.service';

describe('KapsoMediaResolverService', () => {
  it('rejects an untrusted media URL without making a request', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const service = new KapsoMediaResolverService({ get: jest.fn() } as never);
    await expect(
      service.resolve({
        id: null,
        url: 'http://127.0.0.1/private',
        mimeType: 'image/jpeg',
        caption: null,
      }),
    ).resolves.toEqual({ ok: false, reason: 'blocked_url' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

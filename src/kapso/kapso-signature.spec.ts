import { createHmac } from 'node:crypto';
import { verifyKapsoSignature } from './kapso-signature';

describe('verifyKapsoSignature', () => {
  const secret = 'test-webhook-secret';
  const body = Buffer.from('{"message":{"id":"wamid.test"}}');

  it('accepts a valid HMAC over the raw body', () => {
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyKapsoSignature(body, signature, secret)).toBe(true);
  });

  it('rejects an invalid or malformed HMAC', () => {
    expect(verifyKapsoSignature(body, 'not-a-signature', secret)).toBe(false);
    expect(verifyKapsoSignature(body, '0'.repeat(64), secret)).toBe(false);
  });
});

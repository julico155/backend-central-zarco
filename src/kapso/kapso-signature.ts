import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const HEX_SHA256_RE = /^[0-9a-fA-F]{64}$/;

/** Kapso V2 sends a direct 64-character SHA-256 hex HMAC, without prefix. */
export function verifyKapsoSignature(
  rawBody: Buffer | string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!secret || !signature || !HEX_SHA256_RE.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedHash = createHash('sha256').update(expected).digest();
  const providedHash = createHash('sha256').update(signature.toLowerCase()).digest();
  return timingSafeEqual(expectedHash, providedHash);
}

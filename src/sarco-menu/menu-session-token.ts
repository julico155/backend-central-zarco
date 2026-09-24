import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Token de sesión del menú web. Puerto directo de sarcoRestaurant
 * (src/lib/menu/session-token.ts): el token es REPRODUCIBLE — el mismo
 * `sourceMessageId` (WAMID) + el mismo secreto siempre generan el mismo
 * token — y nunca se persiste, solo su hash SHA-256 (`menu_sessions.token_hash`).
 *
 * Eso es lo que permite reutilizar una sesión sin tener que guardar el token
 * en claro: se regenera desde el WAMID guardado y se compara el hash.
 */

const HEX_SHA256_RE = /^[0-9a-f]{64}$/;

export function generateMenuSessionToken(sourceMessageId: string, secret: string): string {
  return createHmac('sha256', secret).update(sourceMessageId, 'utf8').digest('base64url');
}

/** Lo único que se persiste. Nunca el token en claro. */
export function hashMenuSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isMenuSessionTokenHash(value: string): boolean {
  return HEX_SHA256_RE.test(value);
}

/** Comparación en tiempo constante contra el hash guardado. */
export function verifyMenuSessionToken(token: string, storedHash: string): boolean {
  if (!token || !isMenuSessionTokenHash(storedHash)) return false;
  const candidate = hashMenuSessionToken(token);
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return timingSafeEqual(a, b);
}

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Tolerancia entre el `t` del header y la hora del servidor. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureCheck =
  | { valid: true }
  | { valid: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' };

/** Firma que genera la plataforma: HMAC-SHA256(secreto, "<t>.<cuerpo crudo>") en hexadecimal. */
export function signSmarkyPayload(secret: string, timestamp: number, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

/**
 * Verifica `Smarky-Signature: t=<unix>,v1=<hex>` sobre el cuerpo CRUDO (el JSON ya
 * parseado y vuelto a serializar cambia bytes y rompe la firma). Compara en tiempo
 * constante y acepta varios `v1` por si la plataforma rota el secreto.
 */
export function verifySmarkySignature(
  secret: string,
  header: string | undefined,
  rawBody: Buffer | undefined,
  nowMs: number = Date.now(),
): SignatureCheck {
  if (!header || !rawBody || !secret) return { valid: false, reason: 'missing' };

  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === 'v1' && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  if (timestamp === null || signatures.length === 0) return { valid: false, reason: 'malformed' };

  if (Math.abs(nowMs / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return { valid: false, reason: 'stale' };
  }

  const expected = Buffer.from(signSmarkyPayload(secret, timestamp, rawBody), 'hex');
  const matches = signatures.some((candidate) => timingSafeEqual(expected, Buffer.from(candidate, 'hex')));
  return matches ? { valid: true } : { valid: false, reason: 'mismatch' };
}

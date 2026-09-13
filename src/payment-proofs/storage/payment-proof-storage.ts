export interface PutObjectInput {
  key: string;
  bytes: Buffer;
  mimeType: string;
}

export interface PaymentProofStorage {
  /** Sube el objeto. Debe ser idempotente ante la misma key (no sobrescribir silenciosamente). */
  putObject(input: PutObjectInput): Promise<void>;
  getObject(key: string): Promise<Buffer>;
}

export const PAYMENT_PROOF_STORAGE = Symbol('PAYMENT_PROOF_STORAGE');

export const PAYMENT_PROOF_MAX_BYTES = 8 * 1024 * 1024; // 8 MB, igual que saas_smarky

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

export function extensionForMimeType(mimeType: string): string | null {
  return MIME_TO_EXTENSION[mimeType] ?? null;
}

/**
 * Key determinística: `<namespace>/<yyyy>/<mm>/<proofId>.<ext>`, portada de
 * `buildPaymentProofKey` (saas_smarky, `src/lib/storage/object-key.ts`).
 * yyyy/mm salen de `createdAt` en UTC — nunca de la hora del reintento, para
 * que un reintento que cruza el cambio de mes no escriba en un mes distinto.
 */
export function buildPaymentProofKey(input: {
  namespace: string;
  proofId: string;
  mimeType: string;
  createdAt: Date;
}): { key: string; extension: string } | { error: 'unsupported_mime' } {
  const extension = extensionForMimeType(input.mimeType);
  if (!extension) return { error: 'unsupported_mime' };

  const year = String(input.createdAt.getUTCFullYear()).padStart(4, '0');
  const month = String(input.createdAt.getUTCMonth() + 1).padStart(2, '0');
  const key = `${input.namespace}/${year}/${month}/${input.proofId.toLowerCase()}.${extension}`;
  return { key, extension };
}

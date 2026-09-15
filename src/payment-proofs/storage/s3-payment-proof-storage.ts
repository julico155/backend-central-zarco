import {
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { PaymentProofStorage, PutObjectInput } from './payment-proof-storage';

export interface S3PaymentProofStorageConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Solo para proveedores S3-compatibles que no son AWS (Cloudflare R2, MinIO, etc.). */
  endpoint?: string;
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  const stream = body as AsyncIterable<Uint8Array>;
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Implementa la misma interfaz `PaymentProofStorage` que
 * `LocalDiskPaymentProofStorage` — swap de provider en
 * PaymentProofsModule, sin tocar la lógica de negocio del intake.
 * `endpoint` vacío apunta a AWS S3; con `endpoint` seteado funciona igual
 * contra cualquier proveedor S3-compatible (Cloudflare R2, MinIO, etc.).
 */
export class S3PaymentProofStorage implements PaymentProofStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3PaymentProofStorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
    });
  }

  /** Igual semántica que LocalDiskPaymentProofStorage: si la key ya existe, no-op (misma key = mismo proofId). */
  async putObject({ key, bytes, mimeType }: PutObjectInput): Promise<void> {
    const exists = await this.headExists(key);
    if (exists) return;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: mimeType,
      }),
    );
  }

  async getObject(key: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return streamToBuffer(result.Body);
  }

  private async headExists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (error instanceof NotFound) return false;
      // Algunos proveedores S3-compatibles devuelven un 404 genérico en vez de NotFound tipado.
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw error;
    }
  }
}

import { Injectable } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PaymentProofStorage, PutObjectInput } from './payment-proof-storage';

/**
 * MVP sin S3/R2 configurado todavía: guarda en disco local bajo un
 * directorio propio. Implementa la misma interfaz `PaymentProofStorage` —
 * swap a S3/R2 real es una clase nueva + un cambio de provider en
 * PaymentProofsModule, sin tocar la lógica de negocio del intake.
 */
@Injectable()
export class LocalDiskPaymentProofStorage implements PaymentProofStorage {
  private readonly baseDir = join(process.cwd(), 'storage', 'payment-proofs');

  async putObject({ key, bytes }: PutObjectInput): Promise<void> {
    const filePath = join(this.baseDir, key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      // 'wx' falla si ya existe — coherente con "no sobrescribir silenciosamente".
      if (error.code !== 'EEXIST') throw error;
    });
  }

  async getObject(key: string): Promise<Buffer> {
    return readFile(join(this.baseDir, key));
  }
}

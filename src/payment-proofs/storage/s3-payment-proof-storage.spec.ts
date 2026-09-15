import { mockClient } from 'aws-sdk-client-mock';
import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { S3PaymentProofStorage } from './s3-payment-proof-storage';

const s3Mock = mockClient(S3Client);

describe('S3PaymentProofStorage', () => {
  const storage = new S3PaymentProofStorage({
    bucket: 'test-bucket',
    region: 'auto',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
  });

  beforeEach(() => s3Mock.reset());
  afterAll(() => (storage as unknown as { client: S3Client }).client.destroy());

  it('sube el objeto cuando la key no existe todavía', async () => {
    s3Mock.on(HeadObjectCommand).rejects(new NotFound({ message: 'not found', $metadata: {} }));
    s3Mock.on(PutObjectCommand).resolves({});

    await storage.putObject({ key: 'k1', bytes: Buffer.from('hola'), mimeType: 'image/jpeg' });

    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
  });

  it('no vuelve a subir si la key ya existe (idempotente, igual que disco local)', async () => {
    s3Mock.on(HeadObjectCommand).resolves({});

    await storage.putObject({ key: 'k1', bytes: Buffer.from('hola'), mimeType: 'image/jpeg' });

    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('lee el objeto y arma el buffer completo', async () => {
    const body = Readable.from([Buffer.from('ho'), Buffer.from('la')]);
    s3Mock.on(GetObjectCommand).resolves({ Body: body as never });

    const bytes = await storage.getObject('k1');

    expect(bytes.toString()).toBe('hola');
  });
});

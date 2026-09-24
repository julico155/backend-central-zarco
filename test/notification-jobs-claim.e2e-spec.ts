import { randomUUID } from 'node:crypto';
import { NotificationsOutService } from '../src/notifications-out/notifications-out.service';
import { createTestDb, describeIfDb } from './utils/test-db';

const fakeGateway = {
  sendTelegramAlert: jest.fn().mockResolvedValue({ externalMessageId: 'telegram-test-id' }),
  sendWhatsappMessage: jest.fn().mockResolvedValue({ externalMessageId: 'whatsapp-test-id' }),
  requestWhatsappLocation: jest.fn().mockResolvedValue(undefined),
};

interface ClaimService {
  claimById(id: string): Promise<{ id: string; claim_token: string } | undefined>;
  recoverFailedJobs(batchSize?: number): Promise<{ claimed: number }>;
}

/**
 * Requiere Postgres real con migraciones aplicadas y DATABASE_URL de test.
 * No llama proveedores: GatewayClientService es un fake local.
 */
describeIfDb('notification_jobs claim (integración PostgreSQL)', () => {
  const targetRefs: string[] = [];
  let db: ReturnType<typeof createTestDb>;
  let serviceA: ClaimService;
  let serviceB: ClaimService;

  beforeAll(() => {
    db = createTestDb();
    serviceA = new NotificationsOutService(db, fakeGateway as never) as unknown as ClaimService;
    serviceB = new NotificationsOutService(db, fakeGateway as never) as unknown as ClaimService;
  });

  afterEach(async () => {
    await db.deleteFrom('notification_jobs').where('target_ref', 'in', targetRefs).execute();
    targetRefs.length = 0;
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await db.destroy();
  });

  async function seed(status: 'pending' | 'sending' | 'sent', claimedUntil?: string) {
    const targetRef = `notification-claim-e2e-${randomUUID()}`;
    targetRefs.push(targetRef);
    const inserted = await db
      .insertInto('notification_jobs')
      .values({
        kind: `notification-claim-e2e-${randomUUID()}`,
        channel: 'telegram',
        target_ref: targetRef,
        payload: JSON.stringify({}),
        status,
        claim_token: status === 'sending' ? randomUUID() : null,
        claimed_until: claimedUntil ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return inserted.id;
  }

  it('two concurrent claims on one pending job yield exactly one owner', async () => {
    const id = await seed('pending');

    const claims = await Promise.all([serviceA.claimById(id), serviceB.claimById(id)]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    const row = await db
      .selectFrom('notification_jobs')
      .select(['status', 'attempts', 'claim_token'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'sending', attempts: 1 });
    expect(row.claim_token).not.toBeNull();
  });

  it('does not reclaim a sent job', async () => {
    const id = await seed('sent');

    await expect(serviceA.claimById(id)).resolves.toBeUndefined();
  });

  it('recovery skips a sending job with a valid lease', async () => {
    await seed('sending', new Date(Date.now() + 60_000).toISOString());

    await expect(serviceA.recoverFailedJobs()).resolves.toEqual({ claimed: 0 });
    expect(fakeGateway.sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('recovery reclaims a sending job with an expired lease', async () => {
    const id = await seed('sending', new Date(Date.now() - 60_000).toISOString());

    await expect(serviceA.recoverFailedJobs()).resolves.toEqual({ claimed: 1 });
    expect(fakeGateway.sendTelegramAlert).toHaveBeenCalledTimes(1);
    await expect(
      db
        .selectFrom('notification_jobs')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ status: 'sent' });
  });

  it('two concurrent recoveries do not claim the same expired lease twice', async () => {
    await seed('sending', new Date(Date.now() - 60_000).toISOString());

    const results = await Promise.all([serviceA.recoverFailedJobs(), serviceB.recoverFailedJobs()]);

    expect(results[0].claimed + results[1].claimed).toBe(1);
    expect(fakeGateway.sendTelegramAlert).toHaveBeenCalledTimes(1);
  });
});

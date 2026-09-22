import { ConfigService } from '@nestjs/config';
import { Kysely } from 'kysely';
import { AppConfig } from '../config/configuration';
import { Database } from '../database/types';
import { CreateLogisticsDeliveryRequest } from './logistics-delivery.mapper';
import {
  LogisticsDispatchWorkerService,
  logisticsDispatchPolicy,
} from './logistics-dispatch-worker.service';
import { LogisticsHttpClientService } from './logistics-http-client.service';

const payload: CreateLogisticsDeliveryRequest = {
  tenantId: 'tenant-a',
  restaurantId: 'restaurant-a',
  branchId: 'branch-a',
  externalOrderId: 'order-a',
  sourceSystem: 'zarco-orders-core',
  pickupAddress: null,
  pickupLatitude: -17.77,
  pickupLongitude: -63.17,
  dropoffAddress: 'Calle 1',
  dropoffLatitude: -17.78,
  dropoffLongitude: -63.18,
  customerName: 'Ana',
  customerPhone: null,
  customerNotes: null,
  deliveryFee: 12,
};

const job = {
  id: 'job-a',
  claimToken: '11111111-1111-4111-8111-111111111111',
  attempts: 1,
  payload,
};

describe('LogisticsDispatchWorkerService', () => {
  afterEach(() => jest.useRealTimers());

  it('marks 201 and idempotent duplicate results as succeeded with the returned ID', async () => {
    for (const result of [
      {
        kind: 'succeeded' as const,
        deliveryId: '22222222-2222-4222-8222-222222222222',
        remoteStatusCode: 201 as const,
      },
      {
        kind: 'succeeded' as const,
        deliveryId: '33333333-3333-4333-8333-333333333333',
        remoteStatusCode: 409 as const,
      },
    ]) {
      const harness = updateHarness();
      const worker = workerWith(harness.database, {
        createDelivery: jest.fn().mockResolvedValue(result),
      });

      await invokeDispatchClaimed(worker, job);

      expect(harness.sets[0]).toEqual(
        expect.objectContaining({
          status: 'succeeded',
          logistics_delivery_id: result.deliveryId,
          remote_status_code: result.remoteStatusCode,
          claim_token: null,
          claimed_until: null,
        }),
      );
      expectClaimOwnership(harness.wheres, job);
    }
  });

  it('fails permanent 409 and 4xx results without scheduling a retry', async () => {
    const harness = updateHarness();
    const worker = workerWith(harness.database, {
      createDelivery: jest.fn().mockResolvedValue({
        kind: 'permanent_failure',
        errorCode: 'conflict',
        remoteStatusCode: 409,
      }),
    });

    await invokeDispatchClaimed(worker, job);

    expect(harness.sets[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        last_error_code: 'conflict',
        remote_status_code: 409,
      }),
    );
  });

  it.each([
    ['rate_limited', 429],
    ['remote_server_error', 500],
    ['timeout', null],
    ['network_error', null],
  ])('returns %s to pending with a retry schedule', async (errorCode, remoteStatusCode) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-21T12:00:00.000Z'));
    const harness = updateHarness();
    const worker = workerWith(harness.database, {
      createDelivery: jest.fn().mockResolvedValue({
        kind: 'retryable_failure',
        errorCode,
        remoteStatusCode,
      }),
    });

    await invokeDispatchClaimed(worker, job);

    expect(harness.sets[0]).toEqual(
      expect.objectContaining({
        status: 'pending',
        last_error_code: errorCode,
        remote_status_code: remoteStatusCode,
        claim_token: null,
        claimed_until: null,
        next_attempt_at: new Date('2026-09-21T12:01:00.000Z'),
      }),
    );
  });

  it('honors Retry-After without exceeding the 30 minute backoff ceiling', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-21T12:00:00.000Z'));
    const harness = updateHarness();
    const worker = workerWith(harness.database, {
      createDelivery: jest.fn().mockResolvedValue({
        kind: 'retryable_failure',
        errorCode: 'rate_limited',
        remoteStatusCode: 429,
        retryAfterMs: 2 * 60 * 60_000,
      }),
    });

    await invokeDispatchClaimed(worker, { ...job, attempts: 7 });

    expect(harness.sets[0]).toEqual(
      expect.objectContaining({ next_attempt_at: new Date('2026-09-21T12:30:00.000Z') }),
    );
    expect(logisticsDispatchPolicy.maxBackoffMs).toBe(30 * 60_000);
  });

  it('fails a retryable result on attempt eight', async () => {
    const harness = updateHarness();
    const worker = workerWith(harness.database, {
      createDelivery: jest.fn().mockResolvedValue({
        kind: 'retryable_failure',
        errorCode: 'network_error',
        remoteStatusCode: null,
      }),
    });

    await invokeDispatchClaimed(worker, { ...job, attempts: 8 });

    expect(harness.sets[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        last_error_code: 'max_attempts_exceeded',
      }),
    );
  });

  it('uses the stored payload snapshot directly and does nothing while disabled', async () => {
    const harness = updateHarness();
    const client = {
      createDelivery: jest.fn().mockResolvedValue({
        kind: 'permanent_failure',
        errorCode: 'conflict',
        remoteStatusCode: 409,
      }),
    };
    const enabledWorker = workerWith(harness.database, client);

    await invokeDispatchClaimed(enabledWorker, job);
    expect(client.createDelivery).toHaveBeenCalledWith(payload);

    const disabledWorker = workerWith(harness.database, client, false);
    await expect(disabledWorker.dispatchPending()).resolves.toEqual({ claimed: 0, recovered: 0 });
    expect(client.createDelivery).toHaveBeenCalledTimes(1);
  });

  it('claims pending jobs with FOR UPDATE SKIP LOCKED so two workers cannot take one job', async () => {
    let locked = false;
    const forUpdate = jest.fn();
    const skipLocked = jest.fn();
    const candidate = { id: 'job-a', attempts: 0, payload };
    const trx = {
      selectFrom: () => {
        const query = {
          select: () => query,
          where: () => query,
          orderBy: () => query,
          limit: () => query,
          forUpdate: () => {
            forUpdate();
            return query;
          },
          skipLocked: () => {
            skipLocked();
            return query;
          },
          execute: async () => {
            if (locked) return [];
            locked = true;
            return [candidate];
          },
        };
        return query;
      },
      updateTable: () => {
        const update = {
          set: () => update,
          where: () => update,
          returning: () => update,
          executeTakeFirst: async () => ({
            ...candidate,
            attempts: 1,
            claim_token: job.claimToken,
          }),
        };
        return update;
      },
    };
    const database = {
      transaction: () => ({
        execute: (callback: (tx: typeof trx) => Promise<unknown>) => callback(trx),
      }),
    };
    const first = workerWith(database, { createDelivery: jest.fn() });
    const second = workerWith(database, { createDelivery: jest.fn() });

    const [firstClaim, secondClaim] = await Promise.all([
      invokeClaimPending(first),
      invokeClaimPending(second),
    ]);

    expect(firstClaim).toHaveLength(1);
    expect(secondClaim).toHaveLength(0);
    expect(forUpdate).toHaveBeenCalled();
    expect(skipLocked).toHaveBeenCalled();
  });

  it('recovers only expired leases and protects completion with the current claim token', async () => {
    const harness = updateHarness(2);
    const worker = workerWith(harness.database, { createDelivery: jest.fn() });

    await expect(worker.recoverExpiredLeases()).resolves.toBe(2);
    expect(harness.wheres).toContainEqual(['status', '=', 'sending']);
    expect(harness.wheres).toContainEqual(['claimed_until', '<', expect.anything()]);

    const completionHarness = updateHarness();
    const completionWorker = workerWith(completionHarness.database, {
      createDelivery: jest.fn().mockResolvedValue({
        kind: 'succeeded',
        deliveryId: '44444444-4444-4444-8444-444444444444',
        remoteStatusCode: 201,
      }),
    });
    await invokeDispatchClaimed(completionWorker, job);
    expectClaimOwnership(completionHarness.wheres, job);
  });
});

function workerWith(
  database: unknown,
  client: { createDelivery: jest.Mock },
  enabled = true,
): LogisticsDispatchWorkerService {
  return new LogisticsDispatchWorkerService(
    database as Kysely<Database>,
    { get: () => ({ enabled }) } as unknown as ConfigService<AppConfig, true>,
    client as unknown as LogisticsHttpClientService,
  );
}

async function invokeDispatchClaimed(
  worker: LogisticsDispatchWorkerService,
  claimed = job,
): Promise<void> {
  await (
    worker as unknown as { dispatchClaimedJob: (input: typeof job) => Promise<void> }
  ).dispatchClaimedJob(claimed);
}

async function invokeClaimPending(worker: LogisticsDispatchWorkerService): Promise<unknown[]> {
  return (
    worker as unknown as { claimPendingJobs: (batch: number) => Promise<unknown[]> }
  ).claimPendingJobs(20);
}

function updateHarness(numUpdatedRows = 1) {
  const sets: unknown[] = [];
  const wheres: unknown[][] = [];
  const database = {
    updateTable: () => {
      const update = {
        set: (value: unknown) => {
          sets.push(value);
          return update;
        },
        where: (...arguments_: unknown[]) => {
          wheres.push(arguments_);
          return update;
        },
        execute: jest.fn().mockResolvedValue([]),
        executeTakeFirst: jest.fn().mockResolvedValue({ numUpdatedRows: BigInt(numUpdatedRows) }),
      };
      return update;
    },
  };
  return { database, sets, wheres };
}

function expectClaimOwnership(wheres: unknown[][], claimed: typeof job): void {
  expect(wheres).toContainEqual(['id', '=', claimed.id]);
  expect(wheres).toContainEqual(['status', '=', 'sending']);
  expect(wheres).toContainEqual(['claim_token', '=', claimed.claimToken]);
}

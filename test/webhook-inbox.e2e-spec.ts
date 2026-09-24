import { randomUUID } from 'node:crypto';
import { WebhookInboxDispatcher } from '../src/webhook-inbox/webhook-inbox.dispatcher';
import { WebhookInboxService } from '../src/webhook-inbox/webhook-inbox.service';
import { createAgentTestDb, describeIfAgentDb } from './utils/test-db';

describeIfAgentDb('webhook_events inbox (integración PostgreSQL)', () => {
  const eventIds: string[] = [];
  let db: ReturnType<typeof createAgentTestDb>;
  let dispatch: jest.Mock;
  let serviceA: WebhookInboxService;
  let serviceB: WebhookInboxService;

  beforeAll(() => {
    db = createAgentTestDb();
    dispatch = jest.fn().mockResolvedValue(undefined);
    const dispatcher = { dispatch } as unknown as WebhookInboxDispatcher;
    serviceA = new WebhookInboxService(db, dispatcher);
    serviceB = new WebhookInboxService(db, dispatcher);
  });

  afterEach(async () => {
    if (eventIds.length > 0)
      await db.deleteFrom('webhook_events').where('event_id', 'in', eventIds).execute();
    eventIds.length = 0;
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await db.destroy();
  });

  async function seed(
    status: 'received' | 'processing' | 'processed',
    options: { attempts?: number; claimedUntil?: string } = {},
  ) {
    const eventId = `webhook-inbox-e2e-${randomUUID()}`;
    eventIds.push(eventId);
    const row = await db
      .insertInto('webhook_events')
      .values({
        event_id: eventId,
        event_name: 'whatsapp.message.received',
        message_id: `wamid-${randomUUID()}`,
        payload: JSON.stringify({ message: { id: 'wamid' } }),
        status,
        attempts: options.attempts ?? 0,
        claim_token: status === 'processing' ? randomUUID() : null,
        claimed_until: options.claimedUntil ?? null,
        next_attempt_at: status === 'received' ? new Date(Date.now() - 1_000) : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { eventId, id: row.id };
  }

  it('two concurrent processing attempts claim one received delivery once', async () => {
    const { id } = await seed('received');
    const outcomes = await Promise.all([serviceA.processById(id), serviceB.processById(id)]);
    expect(outcomes.filter((outcome) => outcome === 'processed')).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not reclaim a processed delivery', async () => {
    const { id } = await seed('processed');
    await expect(serviceA.processById(id)).resolves.toBe('not_claimed');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('recovery leaves a valid processing lease alone', async () => {
    await seed('processing', { claimedUntil: new Date(Date.now() + 60_000).toISOString() });
    await expect(serviceA.recoverDue()).resolves.toMatchObject({ claimed: 0 });
  });

  it('recovery claims an expired processing lease', async () => {
    await seed('processing', { claimedUntil: new Date(Date.now() - 60_000).toISOString() });
    await expect(serviceA.recoverDue()).resolves.toMatchObject({ claimed: 1, processed: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('two concurrent recoveries have one owner through SKIP LOCKED', async () => {
    await seed('processing', { claimedUntil: new Date(Date.now() - 60_000).toISOString() });
    const results = await Promise.all([serviceA.recoverDue(), serviceB.recoverDue()]);
    expect(results[0].claimed + results[1].claimed).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not claim an exhausted event', async () => {
    await seed('received', { attempts: 5 });
    await expect(serviceA.recoverDue()).resolves.toMatchObject({ claimed: 0 });
  });
});

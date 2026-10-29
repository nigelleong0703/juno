import { describe, expect, it } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createTriggersService } from '../services/triggers.js';
import { receiptFor } from '../services/event-receipts.js';

function ownedStore() {
  const raw = createMemoryStore();
  if (raw.forOwner === undefined) throw new Error('Owner scope required');
  return raw.forOwner('owner');
}

const event = { id: 'event', source: 'github', type: 'pr.merged' };
const subscription = (id: string, filter: Record<string, unknown> = { source: 'github' }) => ({
  id, agentId: 'agent', conversationId: 'chat', filter,
  expiresAt: '2099-01-01T00:00:00Z', createdAt: '2026-10-08T00:00:00Z',
});
describe('trigger delivery reporting', () => {
  it('does not report a rejected wake as delivered', async () => {
    const store = ownedStore();
    await store.put('subscriptions', subscription('sub'));
    const enqueuer = new NoopEnqueuer();
    enqueuer.enqueue = async () => ({ accepted: false });
    expect(await createTriggersService({ store, enqueuer }).deliverExternal(event)).toMatchObject({ matched: 0 });
  });
  it('matches subscriptions after the first 10,000 rows', async () => {
    const store = ownedStore();
    for (let i = 0; i < 10_001; i++) await store.put('subscriptions', subscription('a-' + String(i).padStart(5, '0'), { source: 'other' }));
    await store.put('subscriptions', subscription('z-match'));
    expect(await createTriggersService({ store, enqueuer: new NoopEnqueuer() }).deliverExternal(event)).toMatchObject({ matched: 1 });
  });
  it('does not deliver a subscription with an invalid expiry', async () => {
    const store = ownedStore();
    await store.put('subscriptions', { ...subscription('sub'), expiresAt: 'invalid' });
    expect(await createTriggersService({ store, enqueuer: new NoopEnqueuer() }).deliverExternal(event)).toMatchObject({ matched: 0 });
  });
  it('resumes a waiting Run without queuing a second wake', async () => {
    const store = ownedStore();
    await store.put('subscriptions', { ...subscription('waiting'), runId: 'run-1' });
    const enqueuer = new NoopEnqueuer();
    let enqueued = 0;
    enqueuer.enqueue = async () => {
      enqueued += 1;
      return { accepted: true };
    };
    const delivered = await createTriggersService({ store, enqueuer }).deliverExternal(event);
    expect(delivered).toMatchObject({ matched: 1, attempted: 1 });
    expect(enqueued).toBe(0);
    expect((await store.get('subscriptions', 'waiting'))?.event).toEqual(event);
  });
  it('never overwrites the first event on a repeated delivery', async () => {
    const store = ownedStore();
    await store.put('subscriptions', { ...subscription('waiting'), runId: 'run-1' });
    const service = createTriggersService({ store, enqueuer: new NoopEnqueuer() });
    await service.deliverExternal(event);
    await service.deliverExternal({ ...event, id: 'event-2', data: { text: 'second' } });
    expect((await store.get('subscriptions', 'waiting'))?.event).toEqual(event);
  });
  it('scopes a waiting Run delivery to its owner, agent and conversation', async () => {
    const store = ownedStore();
    await store.put('subscriptions', { ...subscription('waiting'), runId: 'run-1' });
    const service = createTriggersService({ store, enqueuer: new NoopEnqueuer() });
    const scope = { ownerId: 'owner', agentId: 'agent', conversationId: 'chat' };
    expect(await service.deliverExternal(event, scope)).toMatchObject({ matched: 1, attempted: 1 });
    expect(await service.deliverExternal(event, { ...scope, ownerId: 'other-owner' })).toMatchObject({ matched: 0, attempted: 0 });
    expect(await service.deliverExternal(event, { ...scope, conversationId: 'other-chat' })).toMatchObject({ matched: 0, attempted: 0 });
  });
  it('leaves expired and non-matching waits alone', async () => {
    const store = ownedStore();
    await store.put('subscriptions', { ...subscription('expired', { source: 'github' }), runId: 'run-1', expiresAt: '2000-01-01T00:00:00Z' });
    await store.put('subscriptions', { ...subscription('other', { source: 'gitlab' }), runId: 'run-2' });
    expect(await createTriggersService({ store, enqueuer: new NoopEnqueuer() }).deliverExternal(event)).toMatchObject({ matched: 0, attempted: 0 });
    expect((await store.get('subscriptions', 'expired'))?.event).toBeUndefined();
    expect((await store.get('subscriptions', 'other'))?.event).toBeUndefined();
  });
  it('persists only the first event when two webhooks race on the row lock', async () => {
    // The row mutex serializes the two locked critical sections FIFO, so the first caller
    // wins deterministically on this store exactly as FOR UPDATE serializes them on Postgres.
    const store = ownedStore();
    await store.put('subscriptions', { ...subscription('waiting'), runId: 'run-1' });
    const service = createTriggersService({ store, enqueuer: new NoopEnqueuer() });
    const first = { ...event, id: 'event-1', data: { text: 'first' } };
    const second = { ...event, id: 'event-2', data: { text: 'second' } };
    const [a, b] = await Promise.all([service.deliverExternal(first), service.deliverExternal(second)]);
    expect(a).toMatchObject({ matched: 1, attempted: 1 });
    expect(b).toMatchObject({ matched: 1, attempted: 1 });
    expect((await store.get('subscriptions', 'waiting'))?.event).toEqual(first);
  });
  it('never resurrects a wait the Run already finished', async () => {
    const store = ownedStore();
    await store.put('subscriptions', { ...subscription('waiting'), runId: 'run-1' });
    const service = createTriggersService({ store, enqueuer: new NoopEnqueuer() });
    expect(await service.deliverExternal(event)).toMatchObject({ matched: 1, attempted: 1 });
    await store.delete('subscriptions', 'waiting');
    expect(await service.deliverExternal({ ...event, id: 'event-2' })).toMatchObject({ matched: 0, attempted: 0 });
    expect(await store.get('subscriptions', 'waiting')).toBeNull();
  });
  it('acknowledges a consumed event as duplicate without waking', async () => {
    const store = ownedStore();
    await store.put('subscriptions', { ...subscription('waiting'), runId: 'run-1' });
    const service = createTriggersService({ store, enqueuer: new NoopEnqueuer() });
    expect(await service.deliverExternal(event)).toMatchObject({ matched: 1, attempted: 1, duplicated: 0 });
    // The Run consumed the event and its wait is gone: the finish transaction left a receipt.
    const scope = { ownerId: 'owner', agentId: 'agent', conversationId: 'chat' };
    await store.put('eventReceipts', receiptFor(scope, 'run-1', event, '2026-10-08T00:00:00Z'));
    await store.delete('subscriptions', 'waiting');
    const enqueuer = new NoopEnqueuer();
    let enqueued = 0;
    enqueuer.enqueue = async () => {
      enqueued += 1;
      return { accepted: true };
    };
    // The host webhook always scopes redeliveries to the routine chat, like the first delivery.
    const retry = await createTriggersService({ store, enqueuer }).deliverExternal(event, scope);
    expect(retry).toMatchObject({ matched: 0, attempted: 0, duplicated: 1 });
    expect(enqueued).toBe(0);
    expect(await store.get('subscriptions', 'waiting')).toBeNull();
  });
  it('never re-patches a live wait with an already-consumed event', async () => {
    const store = ownedStore();
    await store.put('subscriptions', { ...subscription('waiting'), runId: 'run-2' });
    const scope = { ownerId: 'owner', agentId: 'agent', conversationId: 'chat' };
    await store.put('eventReceipts', receiptFor(scope, 'run-1', event, '2026-10-08T00:00:00Z'));
    const retry = await createTriggersService({ store, enqueuer: new NoopEnqueuer() }).deliverExternal(event);
    expect(retry).toMatchObject({ matched: 0, attempted: 0, duplicated: 1 });
    expect((await store.get('subscriptions', 'waiting'))?.event).toBeUndefined();
  });
  it('treats the same event id in another scope as a different receipt', async () => {
    const raw = createMemoryStore();
    if (typeof raw.forOwner !== 'function') throw new Error('Owner scope required');
    const store = raw.forOwner('owner');
    await store.put('subscriptions', { ...subscription('waiting'), runId: 'run-1' });
    // Owner A's run consumed this event id and finished; owner B waits with the same filter.
    await raw.forOwner('owner-a').put('eventReceipts', receiptFor(
      { ownerId: 'owner-a', agentId: 'agent', conversationId: 'chat' }, 'run-9', event, '2026-10-08T00:00:00Z',
    ));
    const other = raw.forOwner('other');
    await other.put('subscriptions', { ...subscription('waiting-b'), runId: 'run-2' });
    const service = createTriggersService({ store: other, enqueuer: new NoopEnqueuer() });
    expect(await service.deliverExternal(event)).toMatchObject({ matched: 1, attempted: 1, duplicated: 0 });
    expect((await other.get('subscriptions', 'waiting-b'))?.event).toEqual(event);
  });
  it('wakes normally when only the event type differs', async () => {
    const store = ownedStore();
    await store.put('subscriptions', { ...subscription('waiting'), runId: 'run-1' });
    const scope = { ownerId: 'owner', agentId: 'agent', conversationId: 'chat' };
    await store.put('eventReceipts', receiptFor(scope, 'run-9', event, '2026-10-08T00:00:00Z'));
    const reopened = { ...event, type: 'pr.opened' };
    const service = createTriggersService({ store, enqueuer: new NoopEnqueuer() });
    expect(await service.deliverExternal(reopened)).toMatchObject({ matched: 1, attempted: 1, duplicated: 0 });
    expect((await store.get('subscriptions', 'waiting'))?.event).toEqual(reopened);
  });
  it('serializes a raw webhook delivery against a scoped Run waiter on one row', async () => {
    // The production shape: the host webhook delivers through the raw store while the Run
    // waits through its owner scope. Both lock the same physical row, so the first wins.
    const rawBase = createMemoryStore();
    if (typeof rawBase.forOwner !== 'function') throw new Error('Owner scope required');
    const store = rawBase.forOwner('owner');
    await store.put('subscriptions', { ...subscription('waiting'), runId: 'run-1' });
    const rawService = createTriggersService({ store: rawBase, enqueuer: new NoopEnqueuer() });
    const scopedService = createTriggersService({ store, enqueuer: new NoopEnqueuer() });
    const rawEvent = { ...event, id: 'event-raw', data: { text: 'raw first' } };
    const scopedEvent = { ...event, id: 'event-scoped', data: { text: 'scoped second' } };
    const [a, b] = await Promise.all([rawService.deliverExternal(rawEvent), scopedService.deliverExternal(scopedEvent)]);
    expect(a).toMatchObject({ matched: 1, attempted: 1 });
    expect(b).toMatchObject({ matched: 1, attempted: 1 });
    expect((await store.get('subscriptions', 'waiting'))?.event).toEqual(rawEvent);
  });
});

/**
 * H-69 (event): wait_for with notify:true does not suspend the run; the first matching external event
 * wakes the session once with an untrusted task_done (taskKind event) and the subscription ends.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { Store, ToolContext, WakeEvent } from '../../../contracts/index.js';
import { createTriggersService } from '../services/triggers.js';
import { createWaitForTool } from '../../../modules/tools/tools/waitFor.js';
import { receiveEvent, type SessionIo, type SessionState } from '../services/session.js';

function ownedStore(): Store {
  const raw = createMemoryStore();
  if (raw.forOwner === undefined) throw new Error('Owner scope required');
  return raw.forOwner('owner');
}

const event = { id: 'evt-1', source: 'github', type: 'pr.merged', data: { repo: 'app', pr: 42 } };

class RecordingEnqueuer extends NoopEnqueuer {
  readonly wakes: WakeEvent[] = [];
  override async enqueue(wake?: WakeEvent): Promise<{ accepted: boolean }> {
    if (wake !== undefined) this.wakes.push(wake);
    return { accepted: true };
  }
}

function recordingEnqueuer(): { enqueuer: RecordingEnqueuer; wakes: WakeEvent[] } {
  const enqueuer = new RecordingEnqueuer();
  return { enqueuer, wakes: enqueuer.wakes };
}

function ctxFor(store: Store): ToolContext {
  const wake: WakeEvent = {
    id: 'w', ownerId: 'owner', agentId: 'agent', sessionKey: 'agent:chat', conversationId: 'chat', kind: 'user_message',
    origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, at: '2026-10-09T00:00:00Z', status: 'accepted',
  };
  return { ownerId: 'owner', agentId: 'agent', conversationId: 'chat', runId: 'run-1', stepId: 's', store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), wake, step: async (_n, fn) => fn(), signal: new AbortController().signal };
}

describe('wait_for notify mode', () => {
  it('wakes the session once with a task_done for the first matching event, then ends', async () => {
    const store = ownedStore();
    await createWaitForTool({ store, enqueuer: new NoopEnqueuer() }).execute({ filter: { source: 'github' }, notify: true }, ctxFor(store));
    const subId = (await store.list('subscriptions')).items[0]?.id ?? '';
    const { enqueuer, wakes } = recordingEnqueuer();
    const service = createTriggersService({ store, enqueuer });
    expect(await service.deliverExternal(event)).toMatchObject({ matched: 1, attempted: 1 });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      id: subId + ':done', kind: 'task_done', sessionKey: 'agent:chat', trusted: false, priority: 'background', origin: { type: 'system' },
      payload: { taskId: subId, taskKind: 'event', status: 'completed' },
    });
    expect(String(wakes[0]?.payload['summary'])).toContain('pr.merged');
    expect(await store.get('subscriptions', subId)).toBeNull();
    // A second matching event finds no subscription: nothing more is sent.
    await service.deliverExternal({ ...event, id: 'evt-2' });
    expect(wakes).toHaveLength(1);
  });

  it('keeps the subscription when the wake was not accepted, so a retry can still deliver', async () => {
    const store = ownedStore();
    await createWaitForTool({ store, enqueuer: new NoopEnqueuer() }).execute({ filter: { source: 'github' }, notify: true }, ctxFor(store));
    const enqueuer = new NoopEnqueuer();
    enqueuer.enqueue = async () => ({ accepted: false });
    expect(await createTriggersService({ store, enqueuer }).deliverExternal(event)).toMatchObject({ matched: 0, attempted: 1 });
    expect((await store.list('subscriptions')).items).toHaveLength(1);
  });

  it('refuses a notify wait past the background generation cap', async () => {
    const store = ownedStore();
    const deep = { ...ctxFor(store).wake, kind: 'task_done' as const, origin: { type: 'system' as const }, trusted: false, payload: { taskId: 't', taskKind: 'event', status: 'completed', summary: '', generation: 3 } };
    const result = await createWaitForTool({ store, enqueuer: new NoopEnqueuer() }).execute({ filter: { source: 'github' }, notify: true }, { ...ctxFor(store), wake: deep });
    expect(result.isError).toBe(true);
    expect((await store.list('subscriptions')).items).toEqual([]);
  });

  it('schedules a timeout notice at expiry, which the Session drops once an event consumed the wait', async () => {
    const store = ownedStore();
    const scheduled: Array<{ wake: WakeEvent; delayMs?: number }> = [];
    const enqueuer = new NoopEnqueuer();
    enqueuer.enqueue = async (wake?: WakeEvent, opts?: { delayMs?: number }) => {
      if (wake !== undefined) scheduled.push({ wake, ...(opts?.delayMs === undefined ? {} : { delayMs: opts.delayMs }) });
      return { accepted: true };
    };
    await createWaitForTool({ store, enqueuer }).execute({ filter: { source: 'github' }, notify: true, timeout: '+10m' }, ctxFor(store));
    const subId = (await store.list('subscriptions')).items[0]?.id ?? '';
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(10 * 60_000);
    expect(scheduled[0]?.wake).toMatchObject({ id: subId + ':expired', kind: 'task_done', payload: { taskKind: 'event', status: 'timeout', taskId: subId } });

    let state: SessionState | null = null;
    const io: SessionIo = {
      key: 'agent:chat', readState: async () => state, writeState: (s) => { state = s; }, now: async () => Date.now(),
      newRunId: () => 'run-x', deliver: () => {}, scheduleIdleCompact: () => {}, scheduleFlush: () => {}, startRun: () => {}, cancelRun: () => {},
    };
    const services = { store, brain: {} as never, toolRegistry: { forAgent: async () => [], get: () => undefined } };
    const expiry = scheduled[0]?.wake;
    if (expiry === undefined) throw new Error('no expiry scheduled');
    // Still waiting at expiry: the agent is told it timed out.
    expect((await receiveEvent(io, services, { ...expiry, id: expiry.id + '-a' })).accepted).toBe(true);
    // Consumed by an event first (subscription deleted): the expiry is dropped.
    await store.delete('subscriptions', subId);
    expect(await receiveEvent(io, services, { ...expiry, id: expiry.id + '-b' })).toEqual({ accepted: false, reason: 'already_delivered' });
  });

  it('removes expired session-level subscriptions when an event comes in (H-87)', async () => {
    const store = ownedStore();
    await store.put('subscriptions', { id: 'old-notify', agentId: 'agent', conversationId: 'chat', filter: { source: 'x' }, expiresAt: '2000-01-01T00:00:00Z', createdAt: '2000-01-01T00:00:00Z', notify: true });
    await store.put('subscriptions', { id: 'run-wait', agentId: 'agent', conversationId: 'chat', runId: 'run-9', filter: { source: 'x' }, expiresAt: '2000-01-01T00:00:00Z', createdAt: '2000-01-01T00:00:00Z' });
    await createTriggersService({ store, enqueuer: new NoopEnqueuer() }).deliverExternal(event);
    expect(await store.get('subscriptions', 'old-notify')).toBeNull();
    expect(await store.get('subscriptions', 'run-wait')).not.toBeNull();
  });

  it('keeps a just-expired notify wait so its timeout notice is still accepted after an unrelated event', async () => {
    const store = ownedStore();
    const justExpired = new Date(Date.now() - 60_000).toISOString();
    await store.put('subscriptions', { id: 'fresh-expired', agentId: 'agent', conversationId: 'chat', filter: { source: 'x' }, expiresAt: justExpired, createdAt: justExpired, notify: true });
    await createTriggersService({ store, enqueuer: new NoopEnqueuer() }).deliverExternal({ id: 'unrelated', source: 'other', type: 'ping' });
    expect(await store.get('subscriptions', 'fresh-expired')).not.toBeNull();
    let state: SessionState | null = null;
    const io: SessionIo = {
      key: 'agent:chat', readState: async () => state, writeState: (s) => { state = s; }, now: async () => Date.now(),
      newRunId: () => 'run-y', deliver: () => {}, scheduleIdleCompact: () => {}, scheduleFlush: () => {}, startRun: () => {}, cancelRun: () => {},
    };
    const expiry: WakeEvent = {
      id: 'fresh-expired:expired', ownerId: 'owner', agentId: 'agent', sessionKey: 'agent:chat', conversationId: 'chat', kind: 'task_done',
      origin: { type: 'system' }, trusted: false, priority: 'background',
      payload: { taskId: 'fresh-expired', taskKind: 'event', status: 'timeout', summary: 'none' }, at: justExpired, status: 'accepted',
    };
    const services = { store, brain: {} as never, toolRegistry: { forAgent: async () => [], get: () => undefined } };
    expect((await receiveEvent(io, services, expiry)).accepted).toBe(true);
  });
});

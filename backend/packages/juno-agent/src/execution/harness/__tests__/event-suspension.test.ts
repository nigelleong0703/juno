import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { AssistantTurn, Brain, BrainContext, ToolRegistry, ToolContext, WakeEvent } from '../../../contracts/index.js';
import type { Run } from '@agent-desktop/public-contracts';
import { CANCELLED, NEVER_CANCELLED, type RunCancellation } from '../services/cancel.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';
import { createWaitForTool } from '../../../modules/tools/tools/waitFor.js';
import { createTriggersService } from '../services/triggers.js';
import { eventReceiptId } from '../services/event-receipts.js';
import { handleSuspension } from '../engines/pi-core/suspend.js';
const at = '2026-10-06T00:00:00.000Z';
const sessionKey = 'agent-1:conv-1';
const input: RunInput = { agentId: 'agent-1', conversationId: 'conv-1', sessionKey, wakeEvents: [] };
function brain(): Brain {
  return {
    async buildContext(): Promise<BrainContext> {
      return { sessionKey, agentId: 'agent-1' };
    },
    async step(): Promise<AssistantTurn> {
      throw new Error('the recovery path never calls the model');
    },
    shouldCompact(): boolean {
      return false;
    },
    async compact(ctx: BrainContext): Promise<BrainContext> {
      return ctx;
    },
  };
}

function registry(): ToolRegistry {
  return {
    async forAgent() {
      return [];
    },
    get: () => undefined,
  };
}

function run(): Run {
  return {
    id: 'run-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    title: 'test',
    status: 'running',
    kind: 'chat',
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: at,
    lastActivityAt: at,
  };
}


async function setup() {
  const store = createMemoryStore();
  await store.put('runs', run());
  const enqueuer = new NoopEnqueuer();
  const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer, brain: brain(), toolRegistry: registry() };
  let clock = Date.now();
  const sleeps: number[] = [];
  let onSleep = async () => {};
  const inbox: WakeEvent[] = [];
  const ctx: RunContext = {
    rand: { uuidv4: () => 'id' },
    date: { now: () => RestatePromise.resolve(clock) },
    run: <T>(_name: string, action: () => Promise<T>) => RestatePromise.resolve(action()),
    awakeable: () => { throw new Error('Event wait must not create a human request'); },
    sleep: (ms) => { sleeps.push(ms); clock += ms; return RestatePromise.resolve(onSleep()); },
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>(inbox.splice(0, inbox.length)),
  };
  const toolCtx: ToolContext = {
    ownerId: 'owner', agentId: input.agentId, conversationId: input.conversationId, runId: 'run-1',
    store, blobs: createMemoryBlobStore(), enqueuer, signal: new AbortController().signal, step: async (_name, action) => action(),
    wake: { id: 'wake', ownerId: 'owner', ...input, kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, at, status: 'accepted' },
  };
  const result = await createWaitForTool({ store, enqueuer }).execute({ filter: { source: 'github', type: 'pr.merged' }, timeout: '2500ms' }, toolCtx);
  if (result.suspend === undefined) throw new Error('Missing suspension');
  // The deadline was stamped from the real clock just now; start the fake clock there, not at setup start.
  clock = Date.now();
  const suspend = result.suspend;
  const wait = (cancellation = NEVER_CANCELLED) => handleSuspension({ ctx, services, input, runId: 'run-1', stepIndex: 0, suspend, cancellation });
  const deliver = () => createTriggersService({ store, enqueuer }).deliverExternal({ id: 'event', source: 'github', type: 'pr.merged', data: { text: 'PR 42 merged' } });
  const steer = (text: string): void => {
    inbox.push({
      id: 'steer-1', ownerId: 'owner', agentId: input.agentId, conversationId: input.conversationId,
      sessionKey, kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user',
      payload: { text }, at, status: 'accepted',
    });
  };
  return { store, ctx, sleeps, wait, deliver, steer, setOnSleep: (fn: () => Promise<void>) => { onSleep = fn; } };
}

describe('wait_for event suspension', () => {
  it('resumes from an event delivered before the Run enters its wait', async () => {
    const deps = await setup();
    await deps.deliver();
    expect(await deps.wait()).toBe('resume');
    expect(deps.sleeps).toEqual([]);
    expect((await deps.store.list('subscriptions')).items).toHaveLength(0);
    expect((await deps.store.list('requests')).items).toHaveLength(0);
    expect(JSON.stringify((await deps.store.list('transcripts')).items)).toContain('PR 42 merged');
    expect(JSON.stringify((await deps.store.list('transcripts')).items)).toContain('untrusted');
    // The consuming finish left a durable receipt in the same transaction as the delete.
    const receipt = await deps.store.get('eventReceipts', eventReceiptId(
      { ownerId: 'owner', agentId: 'agent-1', conversationId: 'conv-1' }, 'github', 'pr.merged', 'event',
    ));
    expect(receipt?.runId).toBe('run-1');
  });
  it('observes an event delivered while sleeping and clears the subscription', async () => {
    const deps = await setup();
    deps.setOnSleep(async () => { await deps.deliver(); });
    expect(await deps.wait()).toBe('resume');
    expect(deps.sleeps).toHaveLength(1);
    expect((await deps.store.list('subscriptions')).items).toHaveLength(0);
  });
  it('times out at the stored deadline and records the timeout', async () => {
    const deps = await setup();
    expect(await deps.wait()).toBe('resume');
    expect(deps.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(2500);
    expect((await deps.store.list('subscriptions')).items).toHaveLength(0);
    expect(JSON.stringify((await deps.store.list('transcripts')).items)).toContain('timed out');
    expect(await deps.store.get('eventReceipts', eventReceiptId(
      { ownerId: 'owner', agentId: 'agent-1', conversationId: 'conv-1' }, 'github', 'pr.merged', 'event',
    ))).toBeNull();
  });
  it('uses a persisted event that arrives between the last poll and timeout finish', async () => {
    const deps = await setup();
    const sub = (await deps.store.list('subscriptions')).items[0];
    if (sub === undefined) throw new Error('No subscription');
    deps.ctx.date = { now: () => RestatePromise.resolve((async () => {
      await deps.store.patch('subscriptions', sub.id, { event: { id: 'edge', source: 'github', type: 'pr.merged', data: { text: 'at boundary' } } });
      return Date.parse(sub.expiresAt);
    })()) };
    expect(await deps.wait()).toBe('resume');
    const transcript = JSON.stringify((await deps.store.list('transcripts')).items);
    expect(transcript).toContain('at boundary');
    expect(transcript).not.toContain('timed out');
  });
  it('consumes exactly once when a retry races the consuming finish', async () => {
    const deps = await setup();
    await deps.deliver();
    const retry = { id: 'event', source: 'github', type: 'pr.merged', data: { text: 'PR 42 merged' } };
    const [outcome, second] = await Promise.all([
      deps.wait(),
      createTriggersService({ store: deps.store, enqueuer: new NoopEnqueuer() }).deliverExternal(retry),
    ]);
    expect(outcome).toBe('resume');
    // Either the delivery saw the live wait or the locked finish won first: exactly one wins.
    expect(second.matched + second.duplicated).toBe(1);
    const transcript = JSON.stringify((await deps.store.list('transcripts')).items);
    expect(transcript.match(/PR 42 merged/g)).toHaveLength(1);
    expect((await deps.store.list('subscriptions')).items).toHaveLength(0);
    expect((await deps.store.list('requests')).items).toHaveLength(0);
  });
  it('refuses a subscription bound to a different Run without deleting it', async () => {
    const deps = await setup();
    const sub = (await deps.store.list('subscriptions')).items[0];
    if (sub === undefined) throw new Error('No subscription');
    await deps.store.patch('subscriptions', sub.id, { runId: 'other-run' });
    await expect(deps.wait()).rejects.toThrow(/belong/);
    expect(await deps.store.get('subscriptions', sub.id)).not.toBeNull();
  });
  it.each([['agent', 'other-agent', 'conv-1'], ['conversation', 'agent-1', 'other-conv']])(
    'refuses a subscription bound to a different %s without deleting it',
    async (_label, agentId, conversationId) => {
      const deps = await setup();
      const sub = (await deps.store.list('subscriptions')).items[0];
      if (sub === undefined) throw new Error('No subscription');
      await deps.store.patch('subscriptions', sub.id, { agentId, conversationId });
      await expect(deps.wait()).rejects.toThrow(/belong/);
      expect(await deps.store.get('subscriptions', sub.id)).not.toBeNull();
    },
  );
  it('cancellation never deletes a subscription rebound to another Run', async () => {
    const deps = await setup();
    const sub = (await deps.store.list('subscriptions')).items[0];
    if (sub === undefined) throw new Error('No subscription');
    await deps.store.patch('subscriptions', sub.id, { runId: 'other-run' });
    const stopped: RunCancellation = { ...NEVER_CANCELLED, race: async () => CANCELLED };
    await expect(deps.wait(stopped)).rejects.toThrow(/belong/);
    expect(await deps.store.get('subscriptions', sub.id)).not.toBeNull();
  });
  it('steered input resumes with the steering transcript and clears the wait', async () => {
    const deps = await setup();
    deps.steer('steer: use tabs for the diff');
    expect(await deps.wait()).toBe('resume');
    expect(deps.sleeps).toEqual([]);
    expect((await deps.store.list('subscriptions')).items).toHaveLength(0);
    expect((await deps.store.list('requests')).items).toHaveLength(0);
    const transcript = JSON.stringify((await deps.store.list('transcripts')).items);
    expect(transcript).toContain('use tabs for the diff');
    expect(transcript).not.toContain('timed out');
  });
  it('cancellation clears the pending subscription without an outcome note', async () => {
    const deps = await setup();
    const stopped: RunCancellation = { ...NEVER_CANCELLED, race: async () => CANCELLED };
    expect(await deps.wait(stopped)).toBe('stopped');
    expect((await deps.store.list('subscriptions')).items).toHaveLength(0);
    expect((await deps.store.list('transcripts')).items).toHaveLength(0);
    // A cancelled wait consumed nothing, so a later retry of the same event still wakes.
    expect(await deps.store.get('eventReceipts', eventReceiptId(
      { ownerId: 'owner', agentId: 'agent-1', conversationId: 'conv-1' }, 'github', 'pr.merged', 'event',
    ))).toBeNull();
  });
});

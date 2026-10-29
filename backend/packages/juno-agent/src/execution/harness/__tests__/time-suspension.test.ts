import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { AssistantTurn, Brain, BrainContext, ToolRegistry, WakeEvent } from '../../../contracts/index.js';
import type { Run } from '@agent-desktop/public-contracts';
import { NEVER_CANCELLED, type RunCancellation } from '../services/cancel.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';
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
  const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: brain(), toolRegistry: registry() };
  const sleeps: number[] = [];
  const ctx: RunContext = {
    rand: { uuidv4: () => 'id' },
    date: { now: () => RestatePromise.resolve(1000) },
    run: <T>(_name: string, action: () => Promise<T>) => RestatePromise.resolve(action()),
    awakeable: () => { throw new Error('Time wait must not create a human awakeable'); },
    sleep: (ms) => { sleeps.push(ms); return RestatePromise.resolve(undefined); },
    drainInbox: () => RestatePromise.resolve([]),
  };
  const wait = (until: string, cancellation: RunCancellation = NEVER_CANCELLED) => handleSuspension({
    ctx, services, input, runId: 'run-1', stepIndex: 0, suspend: { reason: 'time', until }, cancellation,
  });
  return { store, ctx, sleeps, wait };
}
describe('durable time suspension', () => {
  it('sleeps only the remaining absolute duration and resumes without a request', async () => {
    const { store, sleeps, wait } = await setup();
    expect(await wait(new Date(61_000).toISOString())).toBe('resume');
    expect(sleeps).toEqual([60_000]);
    expect((await store.list('requests')).items).toHaveLength(0);
    expect((await store.get('runs', 'run-1'))?.status).toBe('running');
  });
  it('resumes immediately for a deadline already passed', async () => {
    const { sleeps, wait } = await setup();
    expect(await wait(new Date(500).toISOString())).toBe('resume');
    expect(sleeps).toEqual([]);
  });
  it('rejects a malformed deadline', async () => {
    const { wait } = await setup();
    await expect(wait('garbage')).rejects.toThrow(/deadline/);
  });
  it('a steerable wake sleeps in slices and resumes at once when input arrives, without a second sleep', async () => {
    const { store, ctx, sleeps } = await setup();
    const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: brain(), toolRegistry: registry() };
    const steer: WakeEvent = { id: 'steer-1', ownerId: 'owner', agentId: 'agent-1', sessionKey, conversationId: 'conv-1', kind: 'task_done', origin: { type: 'system' }, trusted: false, priority: 'background', payload: { text: 'done' }, at, status: 'accepted' };
    let drains = 0;
    ctx.drainInbox = () => { drains += 1; return RestatePromise.resolve(drains < 2 ? [] : [steer]); };
    const outcome = await handleSuspension({
      ctx, services, input, runId: 'run-1', stepIndex: 0, suspend: { reason: 'time', until: new Date(61_000).toISOString() },
      details: { steerable: true }, cancellation: NEVER_CANCELLED,
    });
    expect(outcome).toBe('resume');
    expect(drains).toBe(2);
    // One STEER_WAIT_SLICE_MS slice; the steer lands in the second drain, so no second sleep.
    expect(sleeps).toEqual([5_000]);
  });

  it('fails explicitly when the host has no durable timer', async () => {
    const { ctx, wait } = await setup();
    delete ctx.sleep;
    await expect(wait(new Date(61_000).toISOString())).rejects.toThrow(/timer/);
  });
});

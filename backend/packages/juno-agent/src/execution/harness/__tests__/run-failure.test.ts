import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { JournalMismatchError, RestatePromise, TerminalError } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import {
  sessionKey,
  type Enqueuer,
  type Brain,
  type BrainContext,
  type EventBus,
  type Store,
  type ToolRegistry,
  type WakeEvent,
} from '../../../contracts/index.js';
import type { Agent, Conversation } from '@agent-desktop/public-contracts';
import { requestScopedStore } from '../../../owner-context.js';
import { runWorkflowBody, type RunBodyContext } from '../services/run.js';
import { createEngineRegistry, type EngineAdapter } from '../engines/registry.js';
import type { RunInput, RunServices } from '../services/run-types.js';

const at = '2026-10-06T00:00:00.000Z';
const owner = 'owner-fail';

type MemoryStore = Store & { eventBus: EventBus };

function scoped(raw: MemoryStore, ownerId: string): Store {
  const forOwner = raw.forOwner;
  if (forOwner === undefined) throw new Error('test store must implement forOwner');
  return forOwner(ownerId);
}

function agentFixture(id: string, ownerId: string): Agent {
  return {
    id,
    name: 'Agent ' + id,
    handle: id,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'T',
    status: 'idle',
    section: 'Inbox',
    pinned: false,
    lastActivity: '',
    unreadCount: 0,
    model: {
      planner: { provider: 'p', model: 'm' },
      computer: { provider: 'p', model: 'm' },
      fast: { provider: 'p', model: 'm' },
    },
    channels: [],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdBy: ownerId,
    createdAt: at,
    updatedAt: at,
  };
}

function conversationFixture(id: string, ownerId: string, agentId: string): Conversation {
  return {
    id,
    kind: 'direct',
    agentIds: [agentId],
    memberIds: [ownerId],
    unreadCount: 0,
    lastItemAt: at,
    createdAt: at,
  };
}

function wake(agentId: string, conversationId: string): WakeEvent {
  return {
    id: 'wk-' + agentId,
    ownerId: owner,
    agentId,
    sessionKey: sessionKey(agentId, conversationId),
    conversationId,
    kind: 'user_message',
    origin: { type: 'user' },
    trusted: true,
    priority: 'user',
    payload: { text: 'hi' },
    at,
    status: 'accepted',
  };
}

function stubBrain(): Brain {
  return {
    async buildContext(input): Promise<BrainContext> {
      return { sessionKey: input.sessionKey, agentId: input.agentId };
    },
    async step(): Promise<never> {
      throw new Error('step must not run in this test');
    },
    shouldCompact(): boolean {
      return false;
    },
    async compact(ctx: BrainContext): Promise<BrainContext> {
      return ctx;
    },
  };
}

const emptyRegistry: ToolRegistry = {
  forAgent: async () => [],
  get: () => undefined,
};

function failingAdapter(failure: Error): EngineAdapter {
  return {
    id: 'pi',
    name: 'failing test engine',
    version: '1',
    available: true,
    capabilities: { tools: false, approvals: false, steering: false, deltas: false },
    executeTurn: async () => {
      throw failure;
    },
  };
}

/** A NoopEnqueuer twin that records the real stopRun run id (Noop drops arguments). */
class RecordingEnqueuer {
  calls: Array<{ method: string; args: unknown[] }> = [];
  async enqueue(): Promise<{ accepted: boolean }> {
    this.calls.push({ method: 'enqueue', args: [] });
    return { accepted: true };
  }
  async stopRun(runId: string): Promise<void> {
    this.calls.push({ method: 'stopRun', args: [runId] });
  }
  async resolveAwakeable(): Promise<void> {
    this.calls.push({ method: 'resolveAwakeable', args: [] });
  }
  async scheduleRoutine(): Promise<void> {
    this.calls.push({ method: 'scheduleRoutine', args: [] });
  }
}

function bodyHarness(runId: string): { ctx: RunBodyContext; finished: Array<{ sessionKey: string; runId: string }> } {
  const finished: Array<{ sessionKey: string; runId: string }> = [];
  let counter = 0;
  return {
    finished,
    ctx: {
      key: runId,
      rand: { uuidv4: () => runId + '-' + (counter += 1) },
      run: <T>(_name: string, action: () => Promise<T>): RestatePromise<T> => RestatePromise.resolve(action()),
      awakeable: <T>() => ({ id: runId + '-awake', promise: RestatePromise.resolve(new Promise<T>(() => {})) }),
      drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
      cancel: { peek: async () => false, get: () => RestatePromise.resolve(false) },
      runFinished: async (key: string, failedRunId: string) => {
        finished.push({ sessionKey: key, runId: failedRunId });
      },
    },
  };
}

async function seed(raw: MemoryStore): Promise<RunInput> {
  await scoped(raw, owner).put('agents', agentFixture('agent-1', owner));
  await scoped(raw, owner).put('conversations', conversationFixture('conv-1', owner, 'agent-1'));
  return {
    agentId: 'agent-1',
    conversationId: 'conv-1',
    sessionKey: sessionKey('agent-1', 'conv-1'),
    wakeEvents: [wake('agent-1', 'conv-1')],
  };
}

function servicesFor(store: Store, failureOrAdapter: Error | EngineAdapter, enqueuer: Enqueuer = new NoopEnqueuer()): RunServices {
  const adapter = failureOrAdapter instanceof Error ? failingAdapter(failureOrAdapter) : failureOrAdapter;
  return {
    store, blobs: createMemoryBlobStore(),
    enqueuer,
    brain: stubBrain(),
    toolRegistry: emptyRegistry,
    engines: createEngineRegistry([adapter]),
  };
}

function blockedAdapter(): EngineAdapter {
  return {
    id: 'pi',
    name: 'blocked test engine',
    version: '1',
    available: true,
    capabilities: { tools: false, approvals: false, steering: false, deltas: false },
    executeTurn: async () => 'blocked',
  };
}

/** Reserve a live child of run-1 in owner scope, so terminal cleanup walks a real descendant. */
async function seedLiveChild(raw: MemoryStore): Promise<void> {
  await scoped(raw, owner).put('runs', {
    id: 'run-child-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    parentRunId: 'run-1',
    title: 'child work',
    status: 'running',
    kind: 'background',
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: at,
    lastActivityAt: at,
  });
}

async function ownerEvents(raw: MemoryStore): Promise<string[]> {
  const bus = raw.eventBus.forOwner;
  if (bus === undefined) throw new Error('test event bus must implement forOwner');
  return (await bus(owner).since(0)).map((entry) => entry.event.type);
}

describe('run terminal failure persistence', () => {
  it('fails the run with the terminal message, emits run.finished and releases the session', async () => {
    const raw = createMemoryStore();
    const input = await seed(raw);
    await seedLiveChild(raw);
    const enqueuer = new RecordingEnqueuer();
    const harness = bodyHarness('run-1');
    const failure = new TerminalError('model stream stalled: stream_idle_timeout after 30s');
    await expect(runWorkflowBody(harness.ctx, servicesFor(requestScopedStore(raw), failure, enqueuer), input)).rejects.toThrow(TerminalError);
    const doc = await scoped(raw, owner).get('runs', 'run-1');
    expect(doc?.status).toBe('failed');
    expect(doc?.error).toMatch(/stream_idle_timeout/);
    expect(await ownerEvents(raw)).toContain('RUN_ERROR');
    expect(harness.finished).toEqual([{ sessionKey: input.sessionKey, runId: 'run-1' }]);
    // The starting wake is journaled before the turn runs, but no assistant turn may follow it.
    const transcripts = (await scoped(raw, owner).list('transcripts', { limit: 50 })).items;
    expect(transcripts.length).toBeGreaterThan(0);
    expect(transcripts.every((entry) => entry.message.role !== 'assistant')).toBe(true);
    expect((await scoped(raw, owner).list('items', { limit: 50 })).items).toEqual([]);
    // A permanent failure also orphans nothing: the reserved descendant got its real stop.
    expect(enqueuer.calls.filter((call) => call.method === 'stopRun')).toEqual([{ method: 'stopRun', args: ['run-child-1'] }]);
  });

  it('rethrows a transient failure without finalizing the run or releasing the session', async () => {
    const raw = createMemoryStore();
    const input = await seed(raw);
    await seedLiveChild(raw);
    const enqueuer = new RecordingEnqueuer();
    const harness = bodyHarness('run-1');
    await expect(runWorkflowBody(harness.ctx, servicesFor(requestScopedStore(raw), new Error('Model API error: 502 Timeout'), enqueuer), input)).rejects.toThrow(/502 Timeout/);
    const doc = await scoped(raw, owner).get('runs', 'run-1');
    expect(doc?.status).toBe('running');
    expect(doc?.error).toBeUndefined();
    expect(await ownerEvents(raw)).not.toContain('RUN_ERROR');
    expect(harness.finished).toEqual([]);
    // A transient retry must never orphan-cancel the descendants the run reserved.
    expect(enqueuer.calls.filter((call) => call.method === 'stopRun')).toEqual([]);
  });

  it('ends a run as stopped, not failed, when a Stop that arrived after the journal was written makes its replay diverge', async () => {
    const raw = createMemoryStore();
    const input = await seed(raw);
    const enqueuer = new RecordingEnqueuer();
    const harness = bodyHarness('run-1');
    // The cancel signal is read live: the replay saw the Stop at a checkpoint the original execution passed before it.
    harness.ctx.cancel = { peek: async () => true, get: () => RestatePromise.resolve(new Promise<boolean>(() => {})) };
    // Journaled steps no longer line up after the divergence: the stop must not touch the journal again.
    const journaled: string[] = [];
    const run = harness.ctx.run;
    harness.ctx.run = <T>(name: string, action: () => Promise<T>): RestatePromise<T> => { journaled.push(name); return run(name, action); };
    const mismatch = new JournalMismatchError(34, '@call Session.drainInbox', 'stop');

    await runWorkflowBody(harness.ctx, servicesFor(requestScopedStore(raw), mismatch, enqueuer), input);

    const doc = await scoped(raw, owner).get('runs', 'run-1');
    expect(doc?.status).toBe('stopped');
    expect(doc?.error).toBeUndefined();
    const types = await ownerEvents(raw);
    expect(types).toContain('RUN_FINISHED');
    expect(types).not.toContain('RUN_ERROR');
    expect(journaled).not.toContain('stop');
    expect(journaled).not.toContain('fail');
  });

  it('still fails a run whose replay diverges when nobody asked it to stop', async () => {
    const raw = createMemoryStore();
    const input = await seed(raw);
    const harness = bodyHarness('run-1');
    const mismatch = new JournalMismatchError(34, '@call Session.drainInbox', 'fail');
    await expect(runWorkflowBody(harness.ctx, servicesFor(requestScopedStore(raw), mismatch), input)).rejects.toThrow(JournalMismatchError);
    expect((await scoped(raw, owner).get('runs', 'run-1'))?.status).toBe('failed');
  });

  it('stops the live children for real before a blocked terminal row lands', async () => {
    const raw = createMemoryStore();
    const input = await seed(raw);
    await seedLiveChild(raw);
    const enqueuer = new RecordingEnqueuer();
    const harness = bodyHarness('run-1');
    await runWorkflowBody(harness.ctx, servicesFor(requestScopedStore(raw), blockedAdapter(), enqueuer), input);
    const doc = await scoped(raw, owner).get('runs', 'run-1');
    expect(doc?.status).toBe('blocked');
    // The descendent got one real stop request through the enqueuer, before the terminal write.
    expect(enqueuer.calls.filter((call) => call.method === 'stopRun')).toEqual([{ method: 'stopRun', args: ['run-child-1'] }]);
    // A blocked run is not a failure on the wire: the segment ends RUN_FINISHED and the durable row (status blocked) stays the authority.
    const types = await ownerEvents(raw);
    expect(types).toContain('RUN_FINISHED');
    expect(types).not.toContain('RUN_ERROR');
  });
});

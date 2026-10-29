/**
 * GC5 request terminal sync. When a Run reaches a terminal state — completed, terminal failed,
 * stopped, or an engine-selection failure — every request it still owns as `pending` must be
 * expired and a `request.resolved` event published for each. Requests the user already answered, and
 * requests another Run owns, are left alone. A Run can own more than one store page (500) of
 * requests, so the sweep follows the keyset cursor instead of stopping at the first page.
 *
 * These drive the real `runWorkflowBody` (with a fake durable ctx) so the transition under test is
 * the workflow's own terminal path, not a re-implementation.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise, TerminalError } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import {
  sessionKey,
  type Brain,
  type BrainContext,
  type EventBus,
  type Store,
  type ToolRegistry,
  type WakeEvent,
} from '../../../contracts/index.js';
import type { Agent, Conversation, Request } from '@agent-desktop/public-contracts';
import { requestScopedStore } from '../../../owner-context.js';
import { runWorkflowBody, type RunBodyContext } from '../services/run.js';
import { createEngineRegistry, type EngineAdapter } from '../engines/registry.js';
import type { RunInput, RunServices } from '../services/run-types.js';

const at = '2026-10-08T00:00:00.000Z';
const owner = 'owner-gc5';
const otherOwner = 'owner-gc5-other';

type MemoryStore = Store & { eventBus: EventBus };

function scoped(raw: MemoryStore, ownerId: string): Store {
  const forOwner = raw.forOwner;
  if (forOwner === undefined) throw new Error('test store must implement forOwner');
  return forOwner(ownerId);
}

function agentFixture(): Agent {
  return {
    id: 'agent-1',
    name: 'Agent 1',
    handle: 'agent-1',
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
    createdBy: owner,
    createdAt: at,
    updatedAt: at,
  };
}

function conversationFixture(): Conversation {
  return {
    id: 'conv-1',
    kind: 'direct',
    agentIds: ['agent-1'],
    memberIds: [owner],
    unreadCount: 0,
    lastItemAt: at,
    createdAt: at,
  };
}

function wake(): WakeEvent {
  return {
    id: 'wake-1',
    ownerId: owner,
    agentId: 'agent-1',
    sessionKey: sessionKey('agent-1', 'conv-1'),
    conversationId: 'conv-1',
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

function adapterWith(outcome: 'completed' | 'stopped'): EngineAdapter {
  return {
    id: 'pi',
    name: 'terminal test engine',
    version: '1',
    available: true,
    capabilities: { tools: false, approvals: false, steering: false, deltas: false },
    executeTurn: async () => outcome,
  };
}

function failingAdapter(): EngineAdapter {
  return {
    ...adapterWith('completed'),
    executeTurn: async () => {
      throw new TerminalError('model stream stalled: stream_idle_timeout after 30s');
    },
  };
}

function transientAdapter(): EngineAdapter {
  return {
    ...adapterWith('completed'),
    executeTurn: async () => {
      throw new Error('Model API error: 502 Timeout');
    },
  };
}

function requestFixture(id: string, runId: string, status: Request['status'] = 'pending'): Request {
  return {
    id,
    // A blocking kind: questions are left open on a normal finish (they never block the run).
    kind: 'signin',
    status,
    title: 'Confirm ' + id,
    summary: '',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    runId,
    payload: { kind: 'signin', site: 'example.com', url: 'https://example.com/login', pausesModel: true },
    createdAt: at,
  };
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

function services(raw: MemoryStore, adapter: EngineAdapter): RunServices {
  return {
    store: requestScopedStore(raw), blobs: createMemoryBlobStore(),
    enqueuer: new NoopEnqueuer(),
    brain: stubBrain(),
    toolRegistry: emptyRegistry,
    engines: createEngineRegistry([adapter]),
  };
}

/** A registry without the shared pi engine, so engine selection fails the Run from the registry. */
function servicesWithoutPi(raw: MemoryStore): RunServices {
  const notPi: EngineAdapter = { ...adapterWith('completed'), id: 'not-pi' };
  return {
    store: requestScopedStore(raw), blobs: createMemoryBlobStore(),
    enqueuer: new NoopEnqueuer(),
    brain: stubBrain(),
    toolRegistry: emptyRegistry,
    engines: createEngineRegistry([notPi]),
  };
}

async function seedRun(raw: MemoryStore, requests: Request[]): Promise<RunInput> {
  await scoped(raw, owner).put('agents', agentFixture());
  await scoped(raw, owner).put('conversations', conversationFixture());
  for (const request of requests) await scoped(raw, owner).put('requests', request);
  return {
    agentId: 'agent-1',
    conversationId: 'conv-1',
    sessionKey: sessionKey('agent-1', 'conv-1'),
    wakeEvents: [wake()],
  };
}

async function statuses(raw: MemoryStore): Promise<Map<string, Request['status']>> {
  const page = await scoped(raw, owner).list('requests', { limit: 1000 });
  return new Map(page.items.map((request) => [request.id, request.status]));
}

async function resolvedEvents(raw: MemoryStore): Promise<Array<{ id: string; status: Request['status'] }>> {
  const bus = raw.eventBus.forOwner;
  if (bus === undefined) throw new Error('test event bus must implement forOwner');
  const entries = await bus(owner).since(0, 2000);
  const resolved: Array<{ id: string; status: Request['status'] }> = [];
  for (const entry of entries) {
    if (entry.event.type === 'request.resolved') resolved.push({ id: entry.event.request.id, status: entry.event.request.status });
  }
  return resolved;
}

describe('GC5 request terminal sync', () => {
  it('expires the completed run pending requests, emits request.resolved, and preserves answered, other-run and other-owner rows', async () => {
    const raw = createMemoryStore();
    const input = await seedRun(raw, [
      requestFixture('req-a', 'run-1'),
      requestFixture('req-b', 'run-1'),
      requestFixture('req-answered', 'run-1', 'answered'),
      requestFixture('req-other-run', 'run-2'),
    ]);
    await scoped(raw, otherOwner).put('requests', requestFixture('req-foreign', 'run-1'));

    await runWorkflowBody(bodyHarness('run-1').ctx, services(raw, adapterWith('completed')), input);

    const byId = await statuses(raw);
    expect(byId.get('req-a')).toBe('expired');
    expect(byId.get('req-b')).toBe('expired');
    expect(byId.get('req-answered')).toBe('answered');
    expect(byId.get('req-other-run')).toBe('pending');
    expect((await scoped(raw, otherOwner).get('requests', 'req-foreign'))?.status).toBe('pending');
    expect((await scoped(raw, owner).get('runs', 'run-1'))?.status).toBe('completed');

    const events = await resolvedEvents(raw);
    expect(events.map((e) => e.id).sort()).toEqual(['req-a', 'req-b']);
    expect(events.every((e) => e.status === 'expired')).toBe(true);
  });

  it('expires pending requests and emits request.resolved when the run fails terminally', async () => {
    const raw = createMemoryStore();
    const input = await seedRun(raw, [requestFixture('req-fail', 'run-1')]);
    const harness = bodyHarness('run-1');

    await expect(runWorkflowBody(harness.ctx, services(raw, failingAdapter()), input)).rejects.toThrow(TerminalError);

    expect((await statuses(raw)).get('req-fail')).toBe('expired');
    expect((await scoped(raw, owner).get('runs', 'run-1'))?.status).toBe('failed');
    expect((await resolvedEvents(raw)).map((e) => e.id)).toEqual(['req-fail']);
  });

  it('expires pending requests and emits request.resolved when the run stops', async () => {
    const raw = createMemoryStore();
    const input = await seedRun(raw, [requestFixture('req-stop', 'run-1')]);

    await runWorkflowBody(bodyHarness('run-1').ctx, services(raw, adapterWith('stopped')), input);

    expect((await statuses(raw)).get('req-stop')).toBe('expired');
    expect((await scoped(raw, owner).get('runs', 'run-1'))?.status).toBe('stopped');
    expect((await resolvedEvents(raw)).map((e) => e.id)).toEqual(['req-stop']);
  });

  it('leaves pending requests untouched when the run hits a transient error and stays active', async () => {
    const raw = createMemoryStore();
    const input = await seedRun(raw, [requestFixture('req-live', 'run-1')]);

    await expect(runWorkflowBody(bodyHarness('run-1').ctx, services(raw, transientAdapter()), input)).rejects.toThrow(/502 Timeout/);

    expect((await statuses(raw)).get('req-live')).toBe('pending');
    expect((await scoped(raw, owner).get('runs', 'run-1'))?.status).toBe('running');
    expect(await resolvedEvents(raw)).toEqual([]);
  });

  it('expires pending requests and emits request.resolved when engine selection fails the run', async () => {
    const raw = createMemoryStore();
    const input = await seedRun(raw, [requestFixture('req-engine', 'run-1')]);

    await expect(runWorkflowBody(bodyHarness('run-1').ctx, servicesWithoutPi(raw), input)).rejects.toThrow(TerminalError);

    expect((await statuses(raw)).get('req-engine')).toBe('expired');
    expect((await scoped(raw, owner).get('runs', 'run-1'))?.status).toBe('failed');
    expect((await resolvedEvents(raw)).map((e) => e.id)).toEqual(['req-engine']);
  });

  it('sweeps past the 500-row page so all 601 pending requests expire and publish one event each', async () => {
    const raw = createMemoryStore();
    const requests: Request[] = [];
    for (let i = 0; i < 601; i += 1) requests.push(requestFixture('req-' + String(i).padStart(3, '0'), 'run-1'));
    requests.push(requestFixture('req-keep', 'run-2'));
    const input = await seedRun(raw, requests);

    await runWorkflowBody(bodyHarness('run-1').ctx, services(raw, adapterWith('completed')), input);

    const byId = await statuses(raw);
    expect(byId.get('req-keep')).toBe('pending');
    const remainingPending = Array.from(byId.values()).filter((status) => status === 'pending');
    expect(remainingPending).toEqual(['pending']);
    const expired = Array.from(byId.entries()).filter(([, status]) => status === 'expired');
    expect(expired).toHaveLength(601);

    const events = await resolvedEvents(raw);
    expect(events).toHaveLength(601);
    expect(events.every((e) => e.status === 'expired')).toBe(true);
    expect(new Set(events.map((e) => e.id)).size).toBe(601);
  });
});

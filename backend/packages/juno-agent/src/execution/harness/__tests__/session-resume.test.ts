/**
 * PH13 durable session/run resume.
 *
 * The real Run body (`runWorkflowBody`) and the real Session handlers are driven here, not a helper:
 * one invocation's journal is replayed by a second invocation with a forbidden provider and a
 * forbidden effect tool, so a restart must complete without re-running the provider, re-performing a
 * fenced side effect, or duplicating the reply. A fenced action cut off before its result is reported
 * truthfully as interrupted and never re-executed, an older build's raw model turn still replays, and
 * a finished run followed by a new message starts a second run in the same chat with the plan and the
 * messages intact and every write still inside the wake owner's scope.
 */
import { createHash } from 'node:crypto';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { Doc,
  AssistantTurn,
  Brain,
  BrainContext,
  EventBus,
  Store,
  Tool,
  ToolRegistry,
  WakeEvent,
} from '../../../contracts/index.js';
import type { Agent, Conversation, Item } from '@agent-desktop/public-contracts';
import { requestScopedStore } from '../../../owner-context.js';
import { canonicalPlanId, readTaskPlan } from '../../../modules/tasks/state.js';
import { createEngineRegistry, type EngineAdapter } from '../engines/registry.js';
import { runLoop } from '../services/run-loop.js';
import { runWorkflowBody, type RunBodyContext } from '../services/run.js';
import { drainInboxEvents, flushInboxEvent, idleCompactEvent, receiveEvent, runFinishedEvent, type SessionIo } from '../services/session.js';
import { defaultState, type SessionState } from '../services/session-state.js';
import type { RunInput, RunServices } from '../services/run-types.js';

const AT = '2026-10-08T00:00:00.000Z';
const OWNER = 'owner-ph13';
const OTHER = 'owner-ph13-other';
const AGENT = 'agent-ph13';
const CONV = 'conv-ph13';
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };

type MemoryStore = Store & { eventBus: EventBus };

function scoped(raw: MemoryStore, ownerId: string): Store {
  const forOwner = raw.forOwner;
  if (forOwner === undefined) throw new Error('test store must implement forOwner');
  return forOwner(ownerId);
}

function agentFixture(ownerId = OWNER): Agent {
  return {
    id: AGENT, name: 'Agent', handle: AGENT,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'T', status: 'idle', section: 'Inbox', pinned: false, lastActivity: '', unreadCount: 0,
    model: { planner: { provider: 'p', model: 'm' }, computer: { provider: 'p', model: 'm' }, fast: { provider: 'p', model: 'm' } },
    channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false },
    createdBy: ownerId, createdAt: AT, updatedAt: AT,
  };
}

function conversationFixture(ownerId = OWNER): Conversation {
  return { id: CONV, kind: 'direct', agentIds: [AGENT], memberIds: [ownerId], unreadCount: 0, lastItemAt: AT, createdAt: AT };
}

function wake(overrides: Partial<WakeEvent> = {}): WakeEvent {
  return {
    id: 'wake-1', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV,
    kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user',
    payload: { text: 'go', addressed: 'direct' }, at: AT, status: 'accepted', ...overrides,
  };
}
const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [wake()] };

function final(text: string): AssistantTurn {
  return { text, toolCalls: [], usage, stopReason: 'stop' };
}
function toolTurn(id: string, name: string): AssistantTurn {
  return { text: '', toolCalls: [{ id, name, arguments: {} }], usage, stopReason: 'tool_calls' };
}

/** A journaling run body context: a fulfilled step is cached, so a second invocation replays it. */
function bodyHarness(runId: string, journal = new Map<string, unknown>(), ownerDecision?: Promise<unknown>): RunBodyContext & { names: string[] } {
  const names: string[] = [];
  const used = new Set<string>();
  let counter = 0;
  return {
    names,
    key: runId,
    rand: { uuidv4: () => runId + '-' + String((counter += 1)) },
    run: <T>(name: string, action: () => Promise<T>): RestatePromise<T> => {
      if (used.has(name)) throw new Error('duplicate durable step: ' + name);
      used.add(name);
      names.push(name);
      if (journal.has(name)) return RestatePromise.resolve(structuredClone(journal.get(name)) as T);
      return RestatePromise.resolve(action().then((value) => {
        journal.set(name, structuredClone(value));
        return value;
      }));
    },
    awakeable: <T>() => ({ id: runId + '-awake', promise: RestatePromise.resolve(ownerDecision === undefined ? new Promise<T>(() => {}) : ownerDecision as Promise<T>) }),
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
    // Real Restate keeps the cancel promise pending until a stop fires.
    cancel: { peek: async () => false, get: () => RestatePromise.resolve(new Promise<boolean>(() => {})) },
    runFinished: async () => {},
  };
}

function piAdapter(): EngineAdapter {
  return {
    id: 'pi', name: 'PH13 engine', version: '1', available: true,
    capabilities: { tools: true, approvals: true, steering: true, deltas: false },
    executeTurn: async (context) =>
      runLoop(context.ctx, context.services, context.input, context.runId, context.brainCtx, context.cancellation),
  };
}

function registry(tools: Tool[]): ToolRegistry {
  return { forAgent: async () => tools, get: (name) => tools.find((tool) => tool.name === name) };
}
function services(store: Store, brain: Brain, tools: Tool[]): RunServices {
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: registry(tools), engines: createEngineRegistry([piAdapter()]) };
}

function scriptedBrain(turns: AssistantTurn[]): { brain: Brain; calls: () => number } {
  let index = 0;
  return {
    calls: () => index,
    brain: {
      async buildContext(): Promise<BrainContext> {
        return { sessionKey: input.sessionKey, agentId: AGENT };
      },
      async step(): Promise<AssistantTurn> {
        const turn = turns[Math.min(index, turns.length - 1)];
        index += 1;
        if (!turn) throw new Error('no scripted turn');
        return turn;
      },
      shouldCompact: () => false,
      async compact(ctx) {
        return ctx;
      },
    },
  };
}

const forbiddenBrain: Brain = {
  async buildContext(): Promise<BrainContext> {
    return { sessionKey: input.sessionKey, agentId: AGENT };
  },
  async step(): Promise<AssistantTurn> {
    throw new Error('the provider must not be called on a replayed invocation');
  },
  shouldCompact: () => false,
  async compact(ctx) {
    return ctx;
  },
};

const effectTool = (executions: { count: number }): Tool => ({
  name: 'effect',
  description: 'one external effect',
  parameters: { type: 'object' },
  replay: 'never',
  sideEffect: true,
  async execute() {
    executions.count += 1;
    return { content: [{ type: 'text', text: 'effect done' }] };
  },
});

async function seedWorld(raw: MemoryStore, ownerId = OWNER): Promise<void> {
  await scoped(raw, ownerId).put('agents', agentFixture(ownerId));
  await scoped(raw, ownerId).put('conversations', conversationFixture(ownerId));
}

async function replies(raw: Store): Promise<Item[]> {
  return (await raw.list('items', { limit: 100 })).items.filter((item) => item.type === 'agent_message');
}

describe('durable run resume', () => {
  it('replays a journaled invocation without re-running the provider, the fenced effect or the reply', async () => {
    const raw = createMemoryStore();
    await seedWorld(raw);
    const journal = new Map<string, unknown>();
    const executions = { count: 0 };
    const first = scriptedBrain([toolTurn('c1', 'effect'), final('all done')]);
    const facade = requestScopedStore(raw);

    await runWorkflowBody(bodyHarness('run-1', journal), services(facade, first.brain, [effectTool(executions)]), input);
    expect(executions.count).toBe(1);
    expect((await replies(scoped(raw, OWNER))).map((item) => (item.type === 'agent_message' ? item.markdown : ''))).toEqual(['all done']);

    // A restart: the journal is replayed, so the provider and the fenced effect must not run again.
    const second = { count: 0 };
    await runWorkflowBody(bodyHarness('run-1', journal), services(facade, forbiddenBrain, [effectTool(second)]), input);
    expect(second.count).toBe(0);
    expect(first.calls()).toBe(2);
    expect((await replies(scoped(raw, OWNER))).length).toBe(1);
    const run = await scoped(raw, OWNER).get('runs', 'run-1');
    expect(run?.status).toBe('completed');
  });

  it('reports a fenced action cut off before its result as interrupted and never re-runs it', async () => {
    const raw = createMemoryStore();
    await seedWorld(raw);
    const journal = new Map<string, unknown>();
    const executions = { count: 0 };
    const facade = requestScopedStore(raw);
    await runWorkflowBody(bodyHarness('run-1', journal), services(facade, scriptedBrain([toolTurn('c1', 'effect'), final('done')]).brain, [effectTool(executions)]), input);
    expect(executions.count).toBe(1);

    // Simulate the crash that the fence exists for: the fence was journaled, the action's own result
    // step was not. Only the fence survives the restart.
    const crashed = new Map<string, unknown>();
    for (const [key, value] of journal) {
      if (key.includes(':fence') || key.includes(':create') || !key.startsWith('step:') && !key.startsWith('tool:') && !key.startsWith('tool-result:')) {
        crashed.set(key, value);
      }
    }
    expect([...crashed.keys()].some((key) => key.includes(':fence'))).toBe(true);
    expect([...crashed.keys()].some((key) => key.startsWith('tool:'))).toBe(false);
    // The fence crossed but the action never cached a result: that is the crash the fence covers.
    const step = (await scoped(raw, OWNER).list('steps', { limit: 10 })).items[0];
    if (step === undefined) throw new Error('expected one step doc');
    const fencedOnly: Doc<'steps'> & { execution: { fencedAt: string } } = { ...step, execution: { fencedAt: AT } };
    await scoped(raw, OWNER).put('steps', fencedOnly, { runId: 'run-1' });

    // The restart replays the fence without re-running the action and waits on the durable owner request.
    const restarted = scriptedBrain([toolTurn('c1', 'effect'), final('recovered')]);
    let answerOwner!: (value: unknown) => void;
    const ownerDecision = new Promise<unknown>((resolve) => { answerOwner = resolve; });
    const resuming = runWorkflowBody(bodyHarness('run-1', crashed, ownerDecision), services(facade, restarted.brain, [effectTool(executions)]), input);
    let recoveryRequest: Doc<'requests'> | null = null;
    for (let attempt = 0; attempt < 100 && recoveryRequest === null; attempt += 1) {
      recoveryRequest = await scoped(raw, OWNER).get('requests', 'req_recovery_' + createHash('sha256').update(fencedOnly.id).digest('hex').slice(0, 32));
      if (recoveryRequest === null) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(recoveryRequest).toMatchObject({ status: 'pending', reconciliation: { state: 'pending', stepId: fencedOnly.id } });
    expect(executions.count).toBe(1);
    if (recoveryRequest === null) throw new Error('expected the durable owner reconciliation request');
    await scoped(raw, OWNER).patch('requests', recoveryRequest.id, {
      status: 'answered',
      resolution: { action: 'answer', answers: { recovery_outcome: 'still_unknown' } },
      reconciliation: { ...recoveryRequest.reconciliation!, state: 'still_unknown', source: 'owner_report' },
    });
    answerOwner({ action: 'answer' });
    await resuming;
    const transcripts = JSON.stringify((await scoped(raw, OWNER).list('transcripts', { limit: 100 })).items.map((entry) => entry.message));
    expect(transcripts).toContain('interrupted');
    const toolResults = (await scoped(raw, OWNER).list('transcripts', { limit: 100 })).items
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .filter((entry) => entry.message.role === 'toolResult');
    expect(JSON.stringify(toolResults.at(-1))).toContain('interrupted');
  });

  it('restores an older build raw model turn journaled under the first key', async () => {
    const raw = createMemoryStore();
    await seedWorld(raw);
    const journal = new Map<string, unknown>([['model:0', final('old reply')]]);
    const facade = requestScopedStore(raw);

    await runWorkflowBody(bodyHarness('run-1', journal), services(facade, forbiddenBrain, []), input);

    const run = await scoped(raw, OWNER).get('runs', 'run-1');
    expect(run?.status).toBe('completed');
    expect((await replies(scoped(raw, OWNER))).map((item) => (item.type === 'agent_message' ? item.markdown : ''))).toEqual(['old reply']);
  });

  it('resumes a paused run from the saved decision without duplicating the effect or the answer', async () => {
    const raw = createMemoryStore();
    await seedWorld(raw);
    const journal = new Map<string, unknown>();
    const executions = { count: 0 };
    // The tool pauses for the user and reports the durable request it is waiting on.
    const waiting: Tool = {
      name: 'effect', description: 'waits for the user', parameters: { type: 'object' }, replay: 'never', sideEffect: true,
      async execute() {
        executions.count += 1;
        return { content: [{ type: 'text', text: 'asked' }], suspend: { reason: 'user', awakeableId: 'req-1' } };
      },
    };
    // The user answered while the run was paused: the route persisted the decision on the request.
    await scoped(raw, OWNER).put('requests', {
      id: 'req-1', kind: 'question', status: 'answered', title: 'Q', summary: '', agentId: AGENT, conversationId: CONV,
      runId: 'run-1', createdAt: AT,
      payload: { ...{ kind: 'question', ui: { version: 1, blocks: [{ type: 'fields', id: 'form', fields: [{ id: 'f1', label: 'ok?', kind: 'text' }] }] } }, answers: { f1: 'yes' } },
      resolution: { action: 'answer', answers: { f1: 'yes' } },
    } as never);
    const facade = requestScopedStore(raw);
    const first = scriptedBrain([toolTurn('c1', 'effect'), final('done after the answer')]);

    await runWorkflowBody(bodyHarness('run-1', journal), services(facade, first.brain, [waiting]), input);

    expect(executions.count).toBe(1);
    // The suspension itself is durable: a restart replays it rather than re-asking.
    expect([...journal.keys()]).toContain('suspend:0');
    expect((await replies(scoped(raw, OWNER))).map((item) => (item.type === 'agent_message' ? item.markdown : ''))).toEqual(['done after the answer']);
    const answered = async (): Promise<number> =>
      (await scoped(raw, OWNER).list('transcripts', { limit: 100 })).items
        .filter((entry) => entry.message.role === 'user' && JSON.stringify(entry.message).includes('yes')).length;
    expect(await answered()).toBe(1);

    // A restart: the model, the fenced effect and the resumed answer all replay without duplicating.
    const second = scriptedBrain([toolTurn('c1', 'effect'), final('done after the answer')]);
    await runWorkflowBody(bodyHarness('run-1', journal), services(facade, second.brain, [waiting]), input);
    expect(executions.count).toBe(1);
    expect(second.calls()).toBe(0);
    expect(await answered()).toBe(1);
  });
});

describe('session resume', () => {
  interface SessionHarness {
    io: SessionIo;
    started: Array<{ runId: string; input: RunInput }>;
    flushes: string[];
    idle: Array<{ token: string; delayMs: number }>;
    state: () => SessionState | null;
  }

  function sessionHarness(key: string): SessionHarness {
    let state: SessionState | null = null;
    const started: Array<{ runId: string; input: RunInput }> = [];
    const flushes: string[] = [];
    const idle: Array<{ token: string; delayMs: number }> = [];
    const io: SessionIo = {
      key,
      readState: async () => state,
      writeState: (next) => {
        state = next;
      },
      now: async () => Date.parse(AT),
      newRunId: () => 'run-' + String(started.length + 1),
      deliver: () => {},
      scheduleIdleCompact: (token, delayMs) => {
        idle.push({ token, delayMs });
      },
      scheduleFlush: (token) => {
        flushes.push(token);
      },
      startRun: (runId, runInput) => {
        started.push({ runId, input: runInput });
      },
      cancelRun: () => {},
    };
    return { io, started, flushes, idle, state: () => state };
  }

  it('starts a second run in the same chat after a finished run, keeping plan and messages', async () => {
    const raw = createMemoryStore();
    await seedWorld(raw);
    const store = requestScopedStore(raw);
    const harness = sessionHarness(AGENT + ':' + CONV);
    const sessionState = defaultState();

    await receiveEvent(harness.io, { store, brain: forbiddenBrain, toolRegistry: registry([]) }, wake({ id: 'w1' }));
    await flushInboxEvent(harness.io, harness.flushes[0]!);
    expect(harness.started.map((entry) => entry.runId)).toEqual(['run-1']);

    await runWorkflowBody(bodyHarness('run-1'), services(store, scriptedBrain([final('first answer')]).brain, []), harness.started[0]!.input);
    await scoped(raw, OWNER).put('items', {
      id: canonicalPlanId(AGENT, CONV), conversationId: CONV, agentId: AGENT, type: 'plan', runId: 'run-1',
      todos: [{ id: 't1', text: 'Keep me', status: 'done' }], at: AT,
    });
    await runFinishedEvent(harness.io, 'run-1');

    await receiveEvent(harness.io, { store, brain: forbiddenBrain, toolRegistry: registry([]) }, wake({ id: 'w2' }));
    await flushInboxEvent(harness.io, harness.flushes[1]!);
    expect(harness.started.map((entry) => entry.runId)).toEqual(['run-1', 'run-2']);
    await runWorkflowBody(bodyHarness('run-2'), services(store, scriptedBrain([final('second answer')]).brain, []), harness.started[1]!.input);

    const messages = (await replies(scoped(raw, OWNER))).map((item) => (item.type === 'agent_message' ? item.markdown : ''));
    expect(messages).toEqual(['first answer', 'second answer']);
    expect((await readTaskPlan(scoped(raw, OWNER), AGENT, CONV))?.todos.map((todo) => todo.id)).toEqual(['t1']);
    expect((await scoped(raw, OTHER).list('runs')).items).toEqual([]);
    expect((await scoped(raw, OTHER).list('items')).items).toEqual([]);
    void sessionState;
  });

  it('a message that arrives after the run drained its inbox still gets its own run when the run ends', async () => {
    const raw = createMemoryStore();
    await seedWorld(raw);
    const store = requestScopedStore(raw);
    const harness = sessionHarness(AGENT + ':' + CONV);
    const world = { store, brain: forbiddenBrain, toolRegistry: registry([]) };

    await receiveEvent(harness.io, world, wake({ id: 'w1' }));
    await flushInboxEvent(harness.io, harness.flushes[0]!);
    expect((await drainInboxEvents(harness.io)).length).toBe(0);
    // The answer lands between the run's last drain and its end.
    await receiveEvent(harness.io, world, wake({ id: 'w2', payload: { text: 'Muse', addressed: 'direct' } }));
    expect(harness.started.length).toBe(1);
    await runFinishedEvent(harness.io, 'run-1');
    expect(harness.started.map((entry) => entry.runId)).toEqual(['run-1', 'run-2']);
    expect(harness.started[1]!.input.wakeEvents.map((event) => event.id)).toEqual(['w2']);
  });

  it('arms a one-hour idle compaction when a run finishes, and only the newest timer compacts', async () => {
    const raw = createMemoryStore();
    await seedWorld(raw);
    const store = requestScopedStore(raw);
    const compacted: string[] = [];
    const brain: Brain = { ...forbiddenBrain, compactIdle: async ({ sessionKey }) => { compacted.push(sessionKey); } };
    const deps = { store, brain, toolRegistry: registry([]) };
    const harness = sessionHarness(AGENT + ':' + CONV);
    const fire = (token: string) => idleCompactEvent(harness.io, deps, token, (compact) => compact());

    await receiveEvent(harness.io, deps, wake({ id: 'w1' }));
    await flushInboxEvent(harness.io, harness.flushes[0]!);
    await runFinishedEvent(harness.io, 'run-1');
    expect(harness.idle.map((entry) => entry.delayMs)).toEqual([60 * 60_000]);
    const first = harness.idle[0]!.token;

    await fire('stale-token');
    expect(compacted).toEqual([]);

    await receiveEvent(harness.io, deps, wake({ id: 'w2' }));
    await flushInboxEvent(harness.io, harness.flushes[1]!);
    await fire(first); // a run is active again
    await runFinishedEvent(harness.io, 'run-2');
    expect(harness.idle).toHaveLength(2);
    await fire(first); // superseded by the newer idle timer
    expect(compacted).toEqual([]);
    await fire(harness.idle[1]!.token);
    expect(compacted).toEqual([AGENT + ':' + CONV]);
  });

  it('queues a wake to a running child session instead of starting a stray run', async () => {
    const raw = createMemoryStore();
    await seedWorld(raw);
    const store = requestScopedStore(raw);
    const childKey = AGENT + ':' + CONV + '::child:run_child_x';
    const harness = sessionHarness(childKey);
    // A child run is started by startChildRun, so its session never records an active run.
    await receiveEvent(harness.io, { store, brain: forbiddenBrain, toolRegistry: registry([]) }, wake({
      id: 'steer-1', sessionKey: childKey, kind: 'child_task', origin: { type: 'system', id: 'run-parent' }, trusted: false, priority: 'background',
      payload: { prompt: 'also check X', parentRunId: 'run-parent', childRunId: 'run_child_x' }, mode: 'steer',
    }));
    expect(harness.started).toEqual([]);
    expect(harness.state()?.inbox.map((entry) => entry.event.id)).toEqual(['steer-1']);
  });

  it('starts a run on an idle child session for a completion wake, carrying its parent link', async () => {
    const raw = createMemoryStore();
    await seedWorld(raw);
    const store = requestScopedStore(raw);
    const childKey = AGENT + ':' + CONV + '::child:run_child_x';
    const harness = sessionHarness(childKey);
    // A wake that is not a child_message steer (here a task_done) still starts its run on the child session.
    await receiveEvent(harness.io, { store, brain: forbiddenBrain, toolRegistry: registry([]) }, wake({
      id: 'done-1', sessionKey: childKey, kind: 'task_done', origin: { type: 'system', id: 'run-parent' }, trusted: false, priority: 'background',
      payload: { taskId: 'shell-1', parentRunId: 'run-parent', childRunId: 'run_child_x' },
    }));
    expect(harness.started).toHaveLength(1);
    expect(harness.started[0]!.input.sessionKey).toBe(childKey);
    expect(harness.started[0]!.input.wakeEvents[0]!.payload['parentRunId']).toBe('run-parent');
  });
});

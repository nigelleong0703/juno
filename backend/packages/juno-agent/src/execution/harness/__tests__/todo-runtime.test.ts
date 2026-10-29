/**
 * GC13 runtime todo hooks.
 *
 * The runtime reads the authoritative plan (one canonical plan item per agent+conversation), keeps the
 * same run working while tasks are actionable, ends normally once they are done, and blocks honestly
 * when the store cannot be read or the model stops making progress. These drive the real runLoop and
 * the real runWorkflowBody terminal path over a memory store, a scripted brain and no live model call.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import {
  LIMITS,
  sessionKey,
  type AssistantTurn,
  type Brain,
  type BrainContext,
  type EventBus,
  type Store,
  type Tool,
  type ToolContext,
  type ToolRegistry,
  type WakeEvent,
} from '../../../contracts/index.js';
import type { Agent, Conversation, Request, Run, Todo } from '@agent-desktop/public-contracts';
import { requestScopedStore } from '../../../owner-context.js';
import { readTaskPlan } from '../../../modules/tasks/state.js';
import { writeTaskPlan } from '../../../modules/tasks/plan-write.js';
import { createSendMessageTool } from '../../../modules/tools/tools/sendMessage.js';
import { NEVER_CANCELLED } from '../services/cancel.js';
import { runLoop } from '../services/run-loop.js';
import { runWorkflowBody, type RunBodyContext } from '../services/run.js';
import { createEngineRegistry, type EngineAdapter, type EngineOutcome } from '../engines/registry.js';
import { blockedReason, continueHint, reconcileHint } from '../services/task-hooks.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';

const at = '2026-10-08T00:00:00.000Z';
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };
const AGENT = 'agent-1';
const CONV = 'conv-1';
const RUN = 'run-1';

const openTask: Todo = { id: 't1', text: 'Fetch the API key', status: 'pending' };
const doneTask: Todo = { id: 't2', text: 'Draft the report', status: 'done' };
const blockedTask: Todo = {
  id: 't3',
  text: 'Deploy to production',
  status: 'blocked',
  note: 'waiting for the user to approve the release',
};

const wake: WakeEvent = {
  id: 'wake-1', ownerId: 'owner', agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV,
  kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: 'do it' }, at,
  status: 'accepted',
};

const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [wake] };

/** A model that replays the scripted turns and repeats the last one once the script runs out. */
class ScriptedTurns implements Brain {
  private index = 0;
  constructor(private readonly turns: AssistantTurn[]) {}
  async buildContext(): Promise<BrainContext> {
    return { sessionKey: AGENT + ':' + CONV, agentId: AGENT };
  }
  async step(): Promise<AssistantTurn> {
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)];
    this.index += 1;
    if (!turn) throw new Error('no scripted turn');
    return turn;
  }
  shouldCompact(): boolean {
    return false;
  }
  async compact(ctx: BrainContext): Promise<BrainContext> {
    return ctx;
  }
  steps(): number {
    return this.index;
  }
}

function finalTurn(text: string): AssistantTurn {
  return { text, toolCalls: [], usage, stopReason: 'stop' };
}

function toolTurn(name: string): AssistantTurn {
  return { text: '', toolCalls: [{ id: 'call-' + name, name, arguments: {} }], usage, stopReason: 'tool_calls' };
}

function sendText(id: string, text: string): AssistantTurn {
  return { text: '', toolCalls: [{ id, name: 'send_message', arguments: { kind: 'text', text } }], usage, stopReason: 'tool_calls' };
}

/** Replaces the canonical plan with the given todos (merge:false), like a fresh todo_write. */
async function setPlan(store: Store, todos: Todo[], runId = RUN): Promise<void> {
  await writeTaskPlan(store, AGENT, CONV, runId, todos, false);
}

/** Marks every todo of the authoritative plan done, whether it was open or blocked. */
function finishAllTool(store: Store): Tool {
  return {
    name: 'finish_all',
    description: 'marks every plan todo done',
    parameters: { type: 'object', properties: {} },
    replay: 'safe',
    sideEffect: true,
    async execute(_args: unknown, ctx: ToolContext) {
      const plan = await readTaskPlan(store, ctx.agentId, ctx.conversationId);
      if (plan === null) return { content: [{ type: 'text' as const, text: 'no plan' }] };
      const todos = plan.todos.map((todo) => ({ ...todo, status: 'done' as const }));
      await writeTaskPlan(store, ctx.agentId, ctx.conversationId, ctx.runId, todos, false);
      return { content: [{ type: 'text' as const, text: 'all tasks done' }] };
    },
  };
}

/** Records a new task on the canonical plan mid-run, like the model calling todo_write. */
function addTaskTool(store: Store): Tool {
  return {
    name: 'add_task',
    description: 'records one task',
    parameters: { type: 'object', properties: {} },
    replay: 'safe',
    sideEffect: true,
    async execute(_args: unknown, ctx: ToolContext) {
      await writeTaskPlan(store, ctx.agentId, ctx.conversationId, ctx.runId, [openTask], true);
      return { content: [{ type: 'text' as const, text: 'task recorded' }] };
    },
  };
}

function noopTool(): Tool {
  return {
    name: 'noop_probe',
    description: 'does nothing',
    parameters: { type: 'object', properties: {} },
    replay: 'safe',
    sideEffect: true,
    async execute() {
      return { content: [{ type: 'text' as const, text: 'probe' }] };
    },
  };
}

function registryWith(store: Store): ToolRegistry {
  const tools = [
    createSendMessageTool({ store, enqueuer: new NoopEnqueuer() }),
    addTaskTool(store),
    finishAllTool(store),
    noopTool(),
  ];
  return {
    forAgent: async () => tools,
    get: (name) => tools.find((tool) => tool.name === name),
  };
}

function runContext(): RunContext {
  let ids = 0;
  return {
    rand: { uuidv4: () => 'id' + String(ids++) },
    run: <T>(_name: string, action: () => Promise<T>): RestatePromise<T> => RestatePromise.resolve(action()),
    awakeable: <T>(): { id: string; promise: RestatePromise<T> } => ({
      id: 'awake',
      promise: RestatePromise.resolve(new Promise<T>(() => {})),
    }),
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
  };
}

function runDoc(id: string): Run {
  return {
    id, agentId: AGENT, conversationId: CONV, title: 'test', status: 'running', kind: 'chat',
    steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: at, lastActivityAt: at,
  };
}

async function postedMessages(store: Store): Promise<string[]> {
  const messages: string[] = [];
  for (const item of (await store.list('items', { orderBy: 'at', order: 'asc', limit: 200 })).items) {
    if (item.type === 'agent_message') messages.push(item.markdown);
  }
  return messages;
}

async function transcriptJson(store: Store): Promise<string> {
  const entries = (await store.list('transcripts', { limit: 500 })).items;
  return JSON.stringify(entries.map((entry) => entry.message));
}

/** Seeds a run and a scripted brain, then drives the real loop once. */
async function drive(
  turns: AssistantTurn[],
  seed?: (store: Store) => Promise<void>,
  runId = RUN,
): Promise<{ store: Store; brain: ScriptedTurns; outcome: EngineOutcome }> {
  const store = createMemoryStore();
  if (seed) await seed(store);
  await store.put('runs', runDoc(runId), { conversationId: CONV });
  const brain = new ScriptedTurns(turns);
  const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: registryWith(store) };
  const outcome = await runLoop(
    runContext(), services, input, runId, { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED,
  );
  return { store, brain, outcome };
}

describe('GC13 runtime todo hooks', () => {
  it('keeps the run going past an early final, and the plan survives the tool progress', async () => {
    const { store, brain, outcome } = await drive([
      finalTurn('Working on it.'),
      sendText('c1', 'Fetched the API key.'),
      toolTurn('finish_all'),
      finalTurn('Everything is done.'),
    ], (s) => setPlan(s, [openTask, doneTask]));

    expect(outcome).toBe('completed');
    // CT-boundary: an intermediate final over an open plan stays source-private; only the
    // settled final publishes (the send_message delivery still posted its own bubble).
    expect(await postedMessages(store)).toEqual(['Fetched the API key.', 'Everything is done.']);
    const plan = await readTaskPlan(store, AGENT, CONV);
    expect(plan?.todos.map((todo) => [todo.id, todo.status])).toEqual([['t1', 'done'], ['t2', 'done']]);
    const plans = (await store.list('items', { limit: 200 })).items.filter((item) => item.type === 'plan');
    expect(plans).toHaveLength(1);
    expect(await transcriptJson(store)).toContain('internal task check');
    expect(brain.steps()).toBe(4);
  });

  it('honors a task the agent records midway before it may finish', async () => {
    const { store, brain, outcome } = await drive([
      toolTurn('add_task'),
      finalTurn('All done, nothing left.'),
      toolTurn('finish_all'),
      finalTurn('Now it is really done.'),
    ]);

    expect(outcome).toBe('completed');
    // CT-boundary: the provisional "all done" final lands only after the recorded task exists.
    expect(await postedMessages(store)).toEqual(['Now it is really done.']);
    expect(brain.steps()).toBe(4);
    expect(await transcriptJson(store)).toContain('t1');
  });

  it('finishes a fully done plan without nudging', async () => {
    const { store, outcome } = await drive([finalTurn('All set.')], (s) => setPlan(s, [doneTask]));

    expect(outcome).toBe('completed');
    expect(await postedMessages(store)).toEqual(['All set.']);
    expect(await transcriptJson(store)).not.toContain('internal task check');
  });

  it('blocks after bounded no-progress finals instead of looping or claiming completion', async () => {
    const { store, brain, outcome } = await drive([finalTurn('Nothing changed.')], (s) => setPlan(s, [openTask]));

    expect(outcome).toBe('blocked');
    expect(await postedMessages(store)).toEqual(['Nothing changed.']);
    expect(brain.steps()).toBe(4);
    const run = await store.get('runs', RUN);
    expect(run?.status).toBe('running');
    expect(run?.error).toContain('no progress on 1 open task(s)');
    expect(run?.error).toContain('Fetch the API key');
    expect(run?.error).not.toContain('t1');
  });

  it('blocks an exhausted step budget with work still undone', async () => {
    const { store, brain, outcome } = await drive([toolTurn('noop_probe')], (s) => setPlan(s, [openTask]));

    expect(outcome).toBe('blocked');
    expect(brain.steps()).toBe(LIMITS.run.maxSteps);
    expect((await store.get('runs', RUN))?.error).toContain('step limit reached with 1 open task(s)');
  });

  it('never finishes as complete when the task state cannot be read', async () => {
    const raw = createMemoryStore();
    const broken: Store = {
      ...raw,
      list: async (collection, query) => {
        if (collection === 'items') throw new Error('items unavailable');
        return raw.list(collection, query);
      },
    };
    const brain = new ScriptedTurns([finalTurn('Ready when you are.')]);
    const services: RunServices = { store: broken, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: registryWith(broken) };
    await raw.put('runs', runDoc(RUN), { conversationId: CONV });

    const outcome = await runLoop(
      runContext(), services, input, RUN, { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED,
    );

    expect(outcome).toBe('blocked');
    expect((await raw.get('runs', RUN))?.error).toContain('task state unreadable');
    expect(await postedMessages(raw)).toEqual(['Ready when you are.']);
  });

  it('completes a run whose only open tasks wait for the user, with no keep-working hint', async () => {
    const store = createMemoryStore();
    await setPlan(store, [blockedTask, doneTask]);
    await store.put('runs', runDoc(RUN), { conversationId: CONV });
    const context = { sessionKey: input.sessionKey, agentId: AGENT };
    const services = (brain: Brain): RunServices => ({ store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: registryWith(store) });

    const brain = new ScriptedTurns([finalTurn('Which release should I deploy?')]);
    const first = await runLoop(runContext(), services(brain), input, RUN, context, NEVER_CANCELLED);
    expect(first).toBe('completed');
    expect(brain.steps()).toBe(1);
    expect(await postedMessages(store)).toEqual(['Which release should I deploy?']);
    expect(await transcriptJson(store)).not.toContain('internal task check');
    expect((await store.get('runs', RUN))?.error).toBeUndefined();

    // Every later user message ends the same way; the waiting task stays in the one canonical plan.
    await store.put('runs', runDoc('run-2'), { conversationId: CONV });
    const second = await runLoop(runContext(), services(new ScriptedTurns([finalTurn('Still waiting on the release.')])), input, 'run-2', context, NEVER_CANCELLED);
    expect(second).toBe('completed');
    const plan = await readTaskPlan(store, AGENT, CONV);
    expect(plan?.todos.map((todo) => [todo.id, todo.status])).toEqual([['t3', 'blocked'], ['t2', 'done']]);
    const plans = (await store.list('items', { limit: 200 })).items.filter((item) => item.type === 'plan');
    expect(plans).toHaveLength(1);
  });

  it('keeps today\'s behaviour when an actionable task sits next to a waiting one', async () => {
    const { store, brain, outcome } = await drive([finalTurn('Nothing changed.')], (s) => setPlan(s, [openTask, blockedTask]));

    expect(outcome).toBe('blocked');
    expect(brain.steps()).toBe(4);
    expect(await transcriptJson(store)).toContain('internal task check');
    expect((await store.get('runs', RUN))?.error).toContain('no progress on 1 open task(s)');
  });

  it('reconciles the plan when a correction steers the run before it continues', async () => {
    const store = createMemoryStore();
    await setPlan(store, [openTask, blockedTask]);
    await store.put('runs', runDoc(RUN), { conversationId: CONV });
    let resolveFirst: (turn: AssistantTurn) => void = () => {};
    const first = new Promise<AssistantTurn>((resolve) => {
      resolveFirst = resolve;
    });
    const scripted = new ScriptedTurns([toolTurn('finish_all'), finalTurn('Finished after the correction.')]);
    let calls = 0;
    const brain: Brain = {
      async buildContext(): Promise<BrainContext> {
        return { sessionKey: AGENT + ':' + CONV, agentId: AGENT };
      },
      async step(): Promise<AssistantTurn> {
        calls += 1;
        if (calls === 1) return await first;
        return await scripted.step();
      },
      shouldCompact: () => false,
      async compact(ctx: BrainContext): Promise<BrainContext> {
        return ctx;
      },
    };
    const queued: WakeEvent[] = [];
    const inboxCtx: RunContext = {
      ...runContext(),
      drainInbox: () => RestatePromise.resolve<WakeEvent[]>(queued.splice(0, queued.length)),
    };
    const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: registryWith(store) };

    const pending = runLoop(inboxCtx, services, input, RUN, { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED);
    queued.push({ ...wake, id: 'steer-1', payload: { text: 'actually, finish the deploy too' } });
    resolveFirst(finalTurn('stale answer that must be dropped'));

    expect(await pending).toBe('completed');
    const transcript = await transcriptJson(store);
    expect(transcript).toContain('open tasks are');
    expect(transcript).toContain('blocked tasks are');
    expect(transcript).not.toContain('stale answer that must be dropped');
    expect(await postedMessages(store)).toEqual(['Finished after the correction.']);
  });

  it('keeps internal ids in the model hints but out of the user-facing blocked reason', async () => {
    const state = {
      kind: 'plan' as const,
      plan: { id: 'p', conversationId: CONV, agentId: AGENT, type: 'plan' as const, runId: RUN, todos: [openTask, blockedTask], at },
    };

    const hint = continueHint(state) + ' ' + reconcileHint(state);
    expect(hint).toContain('t1');
    expect(hint).toContain('t3');
    expect(hint).not.toContain('finish without a summary');
    expect(hint).toContain('end the run only once every task is done');

    const stalled = blockedReason(state, 'stalled');
    expect(stalled).toContain('no progress on 1 open task(s)');
    expect(blockedReason(state, 'limit')).toContain('step limit reached with 1 open task(s)');
    expect(stalled).not.toContain('t1');
    const waiting = {
      kind: 'plan' as const,
      plan: { id: 'p', conversationId: CONV, agentId: AGENT, type: 'plan' as const, runId: RUN, todos: [blockedTask, doneTask], at },
    };
    expect(blockedReason(waiting, 'waiting')).toContain('waiting for the user to approve the release');
    expect(blockedReason({ kind: 'unreadable', reason: 'boom' }, 'unreadable')).toContain('task state unreadable (boom)');
  });
});

// ---------------------------------------------------------------------------
// The Run's own terminal path: run.status blocked, pending requests expired and
// the still-open tasks marked blocked with the same reason the run records.
// ---------------------------------------------------------------------------

type MemoryStore = Store & { eventBus: EventBus };
const OWNER = 'owner-gc13';

function scoped(raw: MemoryStore, ownerId: string): Store {
  const forOwner = raw.forOwner;
  if (forOwner === undefined) throw new Error('test store must implement forOwner');
  return forOwner(ownerId);
}

function agentFixture(): Agent {
  return {
    id: AGENT, name: 'Agent 1', handle: AGENT,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'T', status: 'idle', section: 'Inbox', pinned: false, lastActivity: '', unreadCount: 0,
    model: { planner: { provider: 'p', model: 'm' }, computer: { provider: 'p', model: 'm' }, fast: { provider: 'p', model: 'm' } },
    channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false },
    createdBy: OWNER, createdAt: at, updatedAt: at,
  };
}

function conversationFixture(): Conversation {
  return {
    id: CONV, kind: 'direct', agentIds: [AGENT], memberIds: [OWNER],
    unreadCount: 0, lastItemAt: at, createdAt: at,
  };
}

function runInput(): RunInput {
  const agentWake: WakeEvent = {
    id: 'wake-1', ownerId: OWNER, agentId: AGENT, sessionKey: sessionKey(AGENT, CONV), conversationId: CONV,
    kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: 'go' }, at,
    status: 'accepted',
  };
  return { agentId: AGENT, conversationId: CONV, sessionKey: sessionKey(AGENT, CONV), wakeEvents: [agentWake] };
}

function requestFixture(id: string): Request {
  return {
    id, kind: 'question', status: 'pending', title: 'Confirm ' + id, summary: '', agentId: AGENT, conversationId: CONV,
    runId: 'run-1', payload: { kind: 'question', ui: { version: 1, blocks: [{ type: 'fields', id: 'form', fields: [{ id: 'f1', label: 'ok?', kind: 'text' }] }] } },
    createdAt: at,
  };
}

/** The production engine adapter: one full turn is the real runLoop. */
function piAdapter(): EngineAdapter {
  return {
    id: 'pi', name: 'GC13 test engine', version: '1', available: true,
    capabilities: { tools: true, approvals: true, steering: true, deltas: false },
    executeTurn: async (context) =>
      runLoop(context.ctx, context.services, context.input, context.runId, context.brainCtx, context.cancellation),
  };
}

const emptyRegistry: ToolRegistry = { forAgent: async () => [], get: () => undefined };

function bodyHarness(runId: string): { ctx: RunBodyContext; finished: Array<{ sessionKey: string; runId: string }> } {
  const finished: Array<{ sessionKey: string; runId: string }> = [];
  let counter = 0;
  return {
    finished,
    ctx: {
      key: runId,
      rand: { uuidv4: () => runId + '-' + String((counter += 1)) },
      run: <T>(_name: string, action: () => Promise<T>): RestatePromise<T> => RestatePromise.resolve(action()),
      awakeable: <T>() => ({ id: runId + '-awake', promise: RestatePromise.resolve(new Promise<T>(() => {})) }),
      drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
      // Real Restate keeps the cancel promise pending until a stop fires (see tool-policy.test.ts).
      cancel: { peek: async () => false, get: () => RestatePromise.resolve(new Promise<boolean>(() => {})) },
      runFinished: async (key: string, failedRunId: string) => {
        finished.push({ sessionKey: key, runId: failedRunId });
      },
    },
  };
}

async function ownerEvents(raw: MemoryStore): Promise<string[]> {
  const bus = raw.eventBus.forOwner;
  if (bus === undefined) throw new Error('test event bus must implement forOwner');
  return (await bus(OWNER).since(0, 5000)).map((entry) => entry.event.type);
}

async function seedBlockedWorld(raw: MemoryStore): Promise<void> {
  await scoped(raw, OWNER).put('agents', agentFixture());
  await scoped(raw, OWNER).put('conversations', conversationFixture());
  await writeTaskPlan(scoped(raw, OWNER), AGENT, CONV, 'run-1', [openTask, blockedTask, doneTask], false);
  await scoped(raw, OWNER).put('requests', requestFixture('req-1'));
}

function blockedServices(raw: MemoryStore, turns: AssistantTurn[]): RunServices {
  return {
    store: requestScopedStore(raw), blobs: createMemoryBlobStore(),
    enqueuer: new NoopEnqueuer(),
    brain: new ScriptedTurns(turns),
    toolRegistry: emptyRegistry,
    engines: createEngineRegistry([piAdapter()]),
  };
}

describe('GC13 blocked terminal run', () => {
  it('blocks the run, expires its pending requests, marks open tasks blocked and releases the session', async () => {
    const raw = createMemoryStore();
    await seedBlockedWorld(raw);
    const harness = bodyHarness('run-1');

    await runWorkflowBody(harness.ctx, blockedServices(raw, [finalTurn('Nothing changed.')]), runInput());

    const run = await scoped(raw, OWNER).get('runs', 'run-1');
    expect(run?.status).toBe('blocked');
    expect(run?.error).toContain('no progress on 1 open task(s)');
    // The open task is marked blocked with the same reason; the done and already-blocked ones stay.
    const plan = await readTaskPlan(scoped(raw, OWNER), AGENT, CONV);
    expect(plan?.todos.map((todo) => [todo.id, todo.status])).toEqual([
      ['t1', 'blocked'], ['t3', 'blocked'], ['t2', 'done'],
    ]);
    expect(plan?.todos[0]?.note).toContain('no progress on 1 open task(s)');
    expect(plan?.todos[1]?.note).toBe('waiting for the user to approve the release');
    expect((await scoped(raw, OWNER).get('requests', 'req-1'))?.status).toBe('expired');
    expect(harness.finished).toEqual([{ sessionKey: runInput().sessionKey, runId: 'run-1' }]);
    expect(await ownerEvents(raw)).toContain('RUN_FINISHED');
  });

  it('completes a later run once only user-waiting tasks remain, without inventing tasks', async () => {
    const raw = createMemoryStore();
    await seedBlockedWorld(raw);
    await runWorkflowBody(bodyHarness('run-1').ctx, blockedServices(raw, [finalTurn('Nothing changed.')]), runInput());

    const second = bodyHarness('run-2');
    await runWorkflowBody(second.ctx, blockedServices(raw, [finalTurn('Can you confirm the release?')]), runInput());

    const run = await scoped(raw, OWNER).get('runs', 'run-2');
    expect(run?.status).toBe('completed');
    expect(run?.error).toBeUndefined();
    expect(second.finished).toEqual([{ sessionKey: runInput().sessionKey, runId: 'run-2' }]);
    const plan = await readTaskPlan(scoped(raw, OWNER), AGENT, CONV);
    expect(plan?.todos.map((todo) => todo.status)).toEqual(['blocked', 'blocked', 'done']);
    // One canonical plan across both runs: no append-only snapshot was invented.
    const plans = (await scoped(raw, OWNER).list('items', { limit: 200 })).items.filter((item) => item.type === 'plan');
    expect(plans).toHaveLength(1);
  });
});

/**
 * PH2 pi-agent-core runtime.
 *
 * These drive the real Run loop with pi-agent-core's low-level `runAgentLoop` as the inner-turn
 * engine: the provider request, the sequential tool batch (validation/beforeToolCall/execute) and
 * the `finishTurn` finalization all come from core, while Restate stays the only durable journal.
 * Failures are deterministic (memory store, scripted brain, no live model call, no sleeps).
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import {
  LIMITS,
  type AssistantTurn,
  type Brain,
  type BrainContext,
  type EventBus,
  type Store,
  type Tool,
  type ToolRegistry,
  type WakeEvent,
} from '../../../contracts/index.js';
import type { Agent, Run, Todo } from '@agent-desktop/public-contracts';
import { runAgentLoop } from '@earendil-works/pi-agent-core';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { requestScopedStore } from '../../../owner-context.js';
import { readTaskPlan } from '../../../modules/tasks/state.js';
import { writeTaskPlan } from '../../../modules/tasks/plan-write.js';
import { coreModel, turnStream } from '../engines/pi-core/messages.js';
import { isRecord, toAgentTools, type CoreToolCall } from '../engines/pi-core/tools.js';
import { createEngineRegistry, type EngineAdapter, type EngineOutcome } from '../engines/registry.js';
import { CANCELLED, NEVER_CANCELLED } from '../services/cancel.js';
import { runLoop } from '../services/run-loop.js';
import { executeSingleToolCall } from '../services/run-tools.js';
import { runWorkflowBody, type RunBodyContext } from '../services/run.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';

const AT = '2026-10-08T00:00:00.000Z';
const OWNER = 'owner-ph2';
const AGENT = 'agent-ph2';
const CONV = 'conv-ph2';
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };

function wake(overrides: Partial<WakeEvent> = {}): WakeEvent {
  return {
    id: 'wake-1', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV,
    kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user',
    payload: { text: 'go', addressed: 'direct' }, at: AT, status: 'accepted', ...overrides,
  };
}
const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [wake()] };

function runDoc(id: string): Run {
  return {
    id, agentId: AGENT, conversationId: CONV, title: 'test', status: 'running', kind: 'chat',
    steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: AT, lastActivityAt: AT,
  };
}

function final(text: string): AssistantTurn {
  return { text, toolCalls: [], usage, stopReason: 'stop' };
}
function truncated(text: string): AssistantTurn {
  return { text, toolCalls: [], usage, stopReason: 'length' };
}
function calls(...cs: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>): AssistantTurn {
  return { text: '', toolCalls: cs.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments ?? {} })), usage, stopReason: 'tool_calls' };
}

/** A model that replays the scripted turns and repeats the last one once the script runs out. */
class ScriptedTurns implements Brain {
  private index = 0;
  constructor(private readonly turns: AssistantTurn[]) {}
  async buildContext(): Promise<BrainContext> {
    return { sessionKey: input.sessionKey, agentId: AGENT };
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

/** A run context that journals by name (reused across passes for the replay case) and refuses duplicates. */
function harnessContext(external?: Map<string, unknown>): { ctx: RunContext; push(event: WakeEvent): void } {
  const journal = external ?? new Map<string, unknown>();
  const used = new Set<string>();
  const inbox: WakeEvent[] = [];
  let seq = 0;
  return {
    push: (event) => {
      inbox.push(event);
    },
    ctx: {
      rand: { uuidv4: () => 'id-' + String(seq++) },
      run<T>(name: string, action: () => Promise<T>): RestatePromise<T> {
        if (used.has(name)) throw new Error('duplicate durable step: ' + name);
        used.add(name);
        if (journal.has(name)) return RestatePromise.resolve(structuredClone(journal.get(name)) as T);
        return RestatePromise.resolve(action().then((value) => {
          journal.set(name, structuredClone(value));
          return value;
        }));
      },
      awakeable<T>(): { id: string; promise: RestatePromise<T> } {
        return { id: 'awake-' + String(seq++), promise: RestatePromise.resolve(new Promise<T>(() => {})) };
      },
      drainInbox: () => RestatePromise.resolve<WakeEvent[]>(inbox.splice(0, inbox.length)),
    },
  };
}

function registry(tools: Tool[]): ToolRegistry {
  return { forAgent: async () => tools, get: (name) => tools.find((tool) => tool.name === name) };
}
function services(store: Store, brain: Brain, tools: Tool[] = []): RunServices {
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: registry(tools) };
}
function countingTool(name: string, schema: Record<string, unknown>, run: () => void): Tool {
  return {
    name, description: name, parameters: schema, replay: 'safe', sideEffect: false,
    async execute() {
      run();
      return { content: [{ type: 'text', text: name + ' ran' }] };
    },
  };
}
const anySchema = { type: 'object', additionalProperties: true };

async function postedMessages(store: Store): Promise<string[]> {
  const messages: string[] = [];
  for (const item of (await store.list('items', { limit: 200 })).items) if (item.type === 'agent_message') messages.push(item.markdown);
  return messages;
}
async function transcriptJson(store: Store): Promise<string> {
  const entries = (await store.list('transcripts', { limit: 300 })).items.slice().sort((a, b) => a.seq - b.seq);
  return JSON.stringify(entries.map((entry) => entry.message));
}

/** A model that records the transcript it actually reads back, so a later turn can be checked for
 * observing the previous turn's tool results. */
function readingBrain(store: Store, turns: AssistantTurn[]): { brain: Brain; contexts: string[] } {
  const contexts: string[] = [];
  let index = 0;
  return {
    contexts,
    brain: {
      async buildContext(): Promise<BrainContext> {
        const entries = (await store.list('transcripts', { limit: 300 })).items.slice().sort((a, b) => a.seq - b.seq);
        contexts.push(JSON.stringify(entries.map((entry) => entry.message)));
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

describe('pi-agent-core inner turn', () => {
  it('runs one core turn per outer step and journals every durable boundary exactly once', async () => {
    const store = createMemoryStore();
    await store.put('runs', runDoc('run-1'), { conversationId: CONV });
    let executed = 0;
    const brain = new ScriptedTurns([calls({ id: 'c1', name: 'ping' }), final('done')]);
    const h = harnessContext();

    const outcome = await runLoop(h.ctx, services(store, brain, [countingTool('ping', anySchema, () => (executed += 1))]), input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED);

    expect(outcome).toBe('completed');
    expect(brain.steps()).toBe(2);
    expect(executed).toBe(1);
    expect(await postedMessages(store)).toEqual(['done']);
    // The executed call is written exactly once: the adapter's own record, not a core duplicate.
    const json = await transcriptJson(store);
    expect(json.match(/"role":"toolResult"/g)).toHaveLength(1);
  });

  it('executes a valid call once, fails an invalid second call before any effect, and continues', async () => {
    const store = createMemoryStore();
    await store.put('runs', runDoc('run-1'), { conversationId: CONV });
    let alpha = 0;
    let beta = 0;
    const strict = { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] };
    const tools = [countingTool('alpha', strict, () => (alpha += 1)), countingTool('beta', strict, () => (beta += 1))];
    const model = readingBrain(store, [
      calls({ id: 'c1', name: 'alpha', arguments: { x: 1 } }, { id: 'c2', name: 'beta', arguments: {} }),
      final('done'),
    ]);

    const outcome = await runLoop(harnessContext().ctx, services(store, model.brain, tools), input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED);

    expect(outcome).toBe('completed');
    expect(alpha).toBe(1);
    expect(beta).toBe(0);
    // The invalid call is a failed step of its own (kind validation), recorded without any effect.
    const steps = (await store.list('steps', { limit: 20 })).items.sort((a, b) => a.index - b.index);
    expect(steps.map((step) => [step.tool, step.status, step.errorKind])).toEqual([['alpha', 'completed', undefined], ['beta', 'failed', 'validation']]);
    // Every tool call of the journaled assistant turn is answered exactly once, and the next real
    // model turn reads the error for the invalid call rather than an orphaned tool call.
    const json = await transcriptJson(store);
    expect(json.match(/"role":"toolResult"/g)).toHaveLength(2);
    expect(model.contexts[0]).toContain('alpha ran');
    expect(model.contexts[0]).toContain('beta');
  });

  it('persists an all-invalid turn so the model observes the failure instead of repeating it', async () => {
    const store = createMemoryStore();
    await store.put('runs', runDoc('run-1'), { conversationId: CONV });
    const model = readingBrain(store, [calls({ id: 'c1', name: 'ghost' }), final('recovered')]);

    const outcome = await runLoop(harnessContext().ctx, services(store, model.brain, []), input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED);

    expect(outcome).toBe('completed');
    const json = await transcriptJson(store);
    expect(json.match(/"role":"toolResult"/g)).toHaveLength(1);
    expect(json).toContain('ghost');
    expect(model.contexts[0]).toContain('ghost');
  });

  it('derives the tool step index from the call source index, not the executed-call count', async () => {
    const store = createMemoryStore();
    await store.put('runs', runDoc('run-1'), { conversationId: CONV });
    let alpha = 0;
    const strict = { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] };
    const tools = [countingTool('alpha', strict, () => (alpha += 1)), countingTool('beta', strict, () => {})];
    const brain = new ScriptedTurns([
      calls({ id: 'c1', name: 'beta', arguments: {} }, { id: 'c2', name: 'alpha', arguments: { x: 1 } }),
      final('done'),
    ]);

    const outcome = await runLoop(harnessContext().ctx, services(store, brain, tools), input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED);

    expect(outcome).toBe('completed');
    expect(alpha).toBe(1);
    const steps = (await store.list('steps', { limit: 10 })).items.sort((a, b) => a.index - b.index);
    expect(steps.map((step) => [step.tool, step.index])).toEqual([['beta', 0], ['alpha', 1]]);
  });

  it('reports an unknown tool as an error result without executing it, and keeps the real result', async () => {
    const store = createMemoryStore();
    await store.put('runs', runDoc('run-1'), { conversationId: CONV });
    let executed = 0;
    const tool = countingTool('echo', anySchema, () => (executed += 1));
    const h = harnessContext();
    const seen: AgentToolResult[] = [];
    let modelCalls = 0;
    const turns = [calls({ id: 'c1', name: 'echo' }, { id: 'c2', name: 'ghost' }), final('done')];

    await runAgentLoop([], {
      messages: [],
      tools: toAgentTools([tool], async (call: CoreToolCall) => {
        const outcome = await executeSingleToolCall(h.ctx, services(store, new ScriptedTurns([]), [tool]), input, 'run-1', 0, modelCalls, { id: call.id, name: call.name, arguments: isRecord(call.args) ? call.args : {} }, NEVER_CANCELLED, []);
        if (outcome === CANCELLED) return { content: [], details: undefined, isError: true, terminate: true };
        return { content: outcome.result.content, details: undefined, terminate: true };
      }),
    }, {
      model: coreModel(),
      convertToLlm: (messages) => messages,
      toolExecution: 'sequential',
      finishTurn: async (turn) => {
        seen.push(...turn.toolResults.map((result) => ({ content: result.content, details: undefined, isError: result.isError })));
        return { action: 'end' };
      },
    }, () => {}, undefined, async () => {
      const turn = turns[Math.min(modelCalls, turns.length - 1)];
      modelCalls += 1;
      return turnStream(turn!);
    });

    expect(executed).toBe(1);
    expect(JSON.stringify(seen[0])).toContain('echo ran');
    expect(seen[1]).toMatchObject({ isError: true });
    expect(JSON.stringify(seen[1])).toContain('ghost');
    const entries = await transcriptJson(store);
    expect(entries.match(/toolResult/g)).toHaveLength(1);
  });

  it('drops a stale tool proposal before execution when a correction steers mid-model (GC11)', async () => {
    const store = createMemoryStore();
    await store.put('runs', runDoc('run-1'), { conversationId: CONV });
    let execute = 0;
    let resolveFirst: (turn: AssistantTurn) => void = () => {};
    const first = new Promise<AssistantTurn>((resolve) => (resolveFirst = resolve));
    let calls0 = 0;
    const brain: Brain = {
      async buildContext(): Promise<BrainContext> {
        return { sessionKey: input.sessionKey, agentId: AGENT };
      },
      async step(): Promise<AssistantTurn> {
        calls0 += 1;
        if (calls0 === 1) return await first;
        return final('answer to the correction');
      },
      shouldCompact: () => false,
      async compact(ctx) {
        return ctx;
      },
    };
    const h = harnessContext();
    const pending = runLoop(h.ctx, services(store, brain, [countingTool('probe', anySchema, () => (execute += 1))]), input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED);
    h.push(wake({ id: 'steer-1', payload: { text: 'actually do this', addressed: 'direct' } }));
    resolveFirst(calls({ id: 'c1', name: 'probe' }));

    expect(await pending).toBe('completed');
    expect(calls0).toBe(2);
    expect(execute).toBe(0);
    expect(await postedMessages(store)).toEqual(['answer to the correction']);
    const entry = await transcriptJson(store);
    expect(entry).not.toContain('probe');
    expect(entry).toContain('actually do this');
  });

  it('keeps the durable tool-result step unique when a provider reuses a call id across turns', async () => {
    const store = createMemoryStore();
    await store.put('runs', runDoc('run-1'), { conversationId: CONV });
    const brain = new ScriptedTurns([calls({ id: 'c1', name: 'ghost' }), calls({ id: 'c1', name: 'ghost' }), final('done')]);
    const h = harnessContext();

    const outcome = await runLoop(h.ctx, services(store, brain, []), input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED);

    expect(outcome).toBe('completed');
    const json = await transcriptJson(store);
    // The strict context rejects a repeated durable step name, so this proves the step-scoped key.
    expect(json.match(/"role":"toolResult"/g)).toHaveLength(2);
    expect(json).toContain('ghost');
  });

  it('drops an all-invalid tool turn before persisting anything when a correction steers (GC11)', async () => {
    const store = createMemoryStore();
    await store.put('runs', runDoc('run-1'), { conversationId: CONV });
    let resolveFirst: (turn: AssistantTurn) => void = () => {};
    const first = new Promise<AssistantTurn>((resolve) => (resolveFirst = resolve));
    let calls0 = 0;
    const brain: Brain = {
      async buildContext(): Promise<BrainContext> {
        return { sessionKey: input.sessionKey, agentId: AGENT };
      },
      async step(): Promise<AssistantTurn> {
        calls0 += 1;
        if (calls0 === 1) return await first;
        return final('answered after the correction');
      },
      shouldCompact: () => false,
      async compact(ctx) {
        return ctx;
      },
    };
    const h = harnessContext();
    const pending = runLoop(h.ctx, services(store, brain, []), input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED);
    h.push(wake({ id: 'steer-1', payload: { text: 'actually do this instead', addressed: 'direct' } }));
    resolveFirst(calls({ id: 'c1', name: 'ghost' }));

    expect(await pending).toBe('completed');
    expect(calls0).toBe(2);
    const json = await transcriptJson(store);
    // The dropped turn leaves only the steering user message: no orphan assistant call, no result.
    expect(json).not.toContain('ghost');
    expect(json).not.toContain('"role":"toolResult"');
    expect(json).toContain('actually do this instead');
    expect(await postedMessages(store)).toEqual(['answered after the correction']);
  });


  it('never delivers a truncated token-limit turn and continues with a durable recovery instruction', async () => {
    const store = createMemoryStore();
    await store.put('runs', runDoc('run-1'), { conversationId: CONV });
    const brain = new ScriptedTurns([truncated('half an answer'), final('complete answer')]);

    const outcome = await runLoop(harnessContext().ctx, services(store, brain), input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED);

    expect(outcome).toBe('completed');
    expect(await postedMessages(store)).toEqual(['complete answer']);
    const entry = await transcriptJson(store);
    expect(entry).toContain('internal recovery');
    expect(entry).toContain('half an answer');
  });

  it('blocks after a bounded number of token-limit stops instead of completing', async () => {
    const store = createMemoryStore();
    await store.put('runs', runDoc('run-1'), { conversationId: CONV });
    const brain = new ScriptedTurns([truncated('half A'), truncated('half B'), truncated('half C')]);

    const outcome = await runLoop(harnessContext().ctx, services(store, brain), input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED);

    expect(outcome).toBe('blocked');
    expect(await postedMessages(store)).toEqual([]);
    expect((await store.get('runs', 'run-1'))?.error).toContain('token limit');
    expect(brain.steps()).toBe(3);
  });

  it('treats step-budget exhaustion in a plan-less run as blocked, never completed', async () => {
    const store = createMemoryStore();
    await store.put('runs', runDoc('run-1'), { conversationId: CONV });
    const brain = new ScriptedTurns([calls({ id: 'c1', name: 'ping' })]);

    const outcome: EngineOutcome = await runLoop(harnessContext().ctx, services(store, brain, [countingTool('ping', anySchema, () => {})]), input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED);

    expect(outcome).toBe('blocked');
    expect(brain.steps()).toBe(LIMITS.run.maxSteps);
    expect((await store.get('runs', 'run-1'))?.error).toContain('step limit');
  });

  it('replays a journal without re-invoking the provider', async () => {
    const journal = new Map<string, unknown>();
    const first = createMemoryStore();
    await first.put('runs', runDoc('run-1'), { conversationId: CONV });
    const brain = new ScriptedTurns([final('hello')]);
    const context = { sessionKey: input.sessionKey, agentId: AGENT };

    expect(await runLoop(harnessContext(journal).ctx, services(first, brain), input, 'run-1', context, NEVER_CANCELLED)).toBe('completed');
    expect(brain.steps()).toBe(1);

    const second = createMemoryStore();
    await second.put('runs', runDoc('run-1'), { conversationId: CONV });
    const forbidden: Brain = {
      async buildContext(): Promise<BrainContext> {
        return context;
      },
      async step(): Promise<AssistantTurn> {
        throw new Error('the provider must not be called on replay');
      },
      shouldCompact: () => false,
      async compact(ctx) {
        return ctx;
      },
    };

    expect(await runLoop(harnessContext(journal).ctx, services(second, forbidden), input, 'run-1', context, NEVER_CANCELLED)).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// The Run's own blocked terminal path: a token-limit block marks the outstanding
// tasks with the same truthful reason the run records.
// ---------------------------------------------------------------------------

type MemoryStore = Store & { eventBus: EventBus };

function scoped(raw: MemoryStore, ownerId: string): Store {
  const forOwner = raw.forOwner;
  if (forOwner === undefined) throw new Error('test store must implement forOwner');
  return forOwner(ownerId);
}

function agentFixture(): Agent {
  return {
    id: AGENT, name: 'Agent', handle: AGENT,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'T', status: 'idle', section: 'Inbox', pinned: false, lastActivity: '', unreadCount: 0,
    model: { planner: { provider: 'p', model: 'm' }, computer: { provider: 'p', model: 'm' }, fast: { provider: 'p', model: 'm' } },
    channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false },
    createdBy: OWNER, createdAt: AT, updatedAt: AT,
  };
}

const openTask: Todo = { id: 't1', text: 'Fetch the API key', status: 'pending' };

function piAdapter(): EngineAdapter {
  return {
    id: 'pi', name: 'PH2 test engine', version: '1', available: true,
    capabilities: { tools: true, approvals: true, steering: true, deltas: false },
    executeTurn: async (context) =>
      runLoop(context.ctx, context.services, context.input, context.runId, context.brainCtx, context.cancellation),
  };
}

const emptyRegistry: ToolRegistry = { forAgent: async () => [], get: () => undefined };

function bodyHarness(runId: string): RunBodyContext {
  let counter = 0;
  return {
    key: runId,
    rand: { uuidv4: () => runId + '-' + String((counter += 1)) },
    run: <T>(_name: string, action: () => Promise<T>): RestatePromise<T> => RestatePromise.resolve(action()),
    awakeable: <T>() => ({ id: runId + '-awake', promise: RestatePromise.resolve(new Promise<T>(() => {})) }),
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
    // The real Restate cancel promise stays pending until a stop fires; a source that resolves
    // `false` makes RestatePromise.race pick the cancel branch and spuriously stops the run.
    cancel: { peek: async () => false, get: () => RestatePromise.resolve(new Promise<boolean>(() => {})) },
    runFinished: async () => {},
  };
}

describe('pi-agent-core token-limit blocked run', () => {
  it('blocks the run and marks outstanding tasks with the token-limit reason', async () => {
    const raw = createMemoryStore();
    const owner = scoped(raw, OWNER);
    await owner.put('agents', agentFixture());
    await owner.put('conversations', { id: CONV, kind: 'direct', agentIds: [AGENT], memberIds: [], unreadCount: 0, lastItemAt: AT, createdAt: AT });
    await writeTaskPlan(owner, AGENT, CONV, 'run-1', [openTask], false);
    const running: RunServices = {
      store: requestScopedStore(raw), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
      brain: new ScriptedTurns([truncated('half')]), toolRegistry: emptyRegistry,
      engines: createEngineRegistry([piAdapter()]),
    };

    await runWorkflowBody(bodyHarness('run-1'), running, input);

    const run = await owner.get('runs', 'run-1');
    expect(run?.status).toBe('blocked');
    expect(run?.error).toContain('token limit');
    const plan = await readTaskPlan(owner, AGENT, CONV);
    expect(plan?.todos[0]?.status).toBe('blocked');
    expect(plan?.todos[0]?.note).toContain('token limit');
  });
});

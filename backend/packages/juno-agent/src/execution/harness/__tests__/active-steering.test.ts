/**
 * GC11 active steering.
 *
 * A user message that arrives while this conversation's run is thinking or executing tools is a
 * correction to the SAME run: the loop consumes it, discards the now-stale model turn (including any
 * tool it proposed), rebuilds the context and continues — instead of posting the superseded reply or
 * starting a second run. A stop that lands while draining posts nothing. Deterministic: memory store,
 * scripted brain, controllable inbox, no live model call.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise, type RestatePromise as RestatePromiseType } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type {
  AssistantTurn,
  Brain,
  BrainContext,
  Store,
  Tool,
  ToolRegistry,
  WakeEvent,
} from '../../../contracts/index.js';
import type { Run } from '@agent-desktop/public-contracts';
import { CANCELLED, NEVER_CANCELLED, type RunCancellation } from '../services/cancel.js';
import { runLoop } from '../services/run-loop.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';

const at = '2026-10-06T00:00:00.000Z';
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };

function steeringWake(id: string, text: string): WakeEvent {
  return {
    id,
    ownerId: 'owner',
    agentId: 'agent-1',
    sessionKey: 'agent-1:conv-1',
    conversationId: 'conv-1',
    kind: 'user_message',
    origin: { type: 'user' },
    trusted: true,
    priority: 'user',
    payload: { text, addressed: 'direct' },
    at,
    status: 'accepted',
  };
}

const input: RunInput = {
  agentId: 'agent-1',
  conversationId: 'conv-1',
  sessionKey: 'agent-1:conv-1',
  wakeEvents: [steeringWake('wake-1', 'start')],
};

const runDoc: Run = {
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

function finalTurn(text: string): AssistantTurn {
  return { text, toolCalls: [], usage, stopReason: 'stop' };
}

function toolTurn(name: string): AssistantTurn {
  return { text: '', toolCalls: [{ id: 'call-' + name, name, arguments: {} }], usage, stopReason: 'tool_calls' };
}

/** A RunContext whose inbox the test controls: `push` queues a steer, `drainInbox` hands it over once. */
interface Inbox {
  ctx: RunContext;
  push(event: WakeEvent): void;
}

function inboxContext(): Inbox {
  const queued: WakeEvent[] = [];
  let ids = 0;
  return {
    push: (event) => {
      queued.push(event);
    },
    ctx: {
      rand: { uuidv4: () => 'id' + ids++ },
      run: <T>(_name: string, action: () => Promise<T>): RestatePromise<T> => RestatePromise.resolve(action()),
      awakeable: <T>(): { id: string; promise: RestatePromise<T> } => ({
        id: 'awake',
        promise: RestatePromise.resolve(new Promise<T>(() => {})),
      }),
      drainInbox: () => RestatePromise.resolve<WakeEvent[]>(queued.splice(0, queued.length)),
    },
  };
}

function servicesFor(store: Store, brain: Brain, tools: Tool[] = []): RunServices {
  const registry: ToolRegistry = {
    forAgent: async () => tools,
    get: (name) => tools.find((tool) => tool.name === name),
  };
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: registry };
}

async function postedMessages(store: Store): Promise<string[]> {
  const items = (await store.list('items', { limit: 50 })).items;
  const messages: string[] = [];
  for (const item of items) if (item.type === 'agent_message') messages.push(item.markdown);
  return messages;
}

/** A brain whose first step blocks on a test-resolved promise, so a steer can land mid-model. */
function deferredFirstStep(store: Store, later: AssistantTurn): {
  brain: Brain;
  contexts: BrainContext[];
  resolveFirst(turn: AssistantTurn): void;
  steps: () => number;
} {
  const contexts: BrainContext[] = [];
  let resolveFirst: (turn: AssistantTurn) => void = () => {};
  const first = new Promise<AssistantTurn>((resolve) => {
    resolveFirst = resolve;
  });
  let calls = 0;
  const brain: Brain = {
    async buildContext(opts): Promise<BrainContext> {
      const entries = (await store.list('transcripts', { limit: 100 })).items
        .slice()
        .sort((a, b) => a.seq - b.seq);
      const context: BrainContext = {
        sessionKey: opts.sessionKey,
        agentId: opts.agentId,
        messages: entries.map((entry) => entry.message),
      };
      contexts.push(context);
      return context;
    },
    async step(): Promise<AssistantTurn> {
      calls += 1;
      if (calls === 1) return await first;
      return later;
    },
    shouldCompact: () => false,
    async compact(ctx): Promise<BrainContext> {
      return ctx;
    },
  };
  return { brain, contexts, resolveFirst, steps: () => calls };
}

/** A cancellation that loses only when the run first drains the inbox (its second durable race). */
function cancelOnSteerDrain(): RunCancellation {
  const state = { cancelled: false };
  let races = 0;
  return {
    signal: new AbortController().signal,
    state,
    async peek(): Promise<boolean> {
      return state.cancelled;
    },
    async race<T>(start: () => RestatePromiseType<T>): Promise<T | typeof CANCELLED> {
      races += 1;
      if (races >= 2) {
        state.cancelled = true;
        return CANCELLED;
      }
      return await start();
    },
    abort(): void {
      state.cancelled = true;
    },
  };
}

describe('active in-flight steering', () => {
  it('discards the stale turn and continues the same run when a correction lands mid-model', async () => {
    const store = createMemoryStore();
    await store.put('runs', runDoc, { conversationId: runDoc.conversationId });
    const executed: string[] = [];
    const probe: Tool = {
      name: 'probe_effect',
      description: 'records an execution',
      parameters: {},
      replay: 'never',
      sideEffect: true,
      async execute() {
        executed.push('probe_effect');
        return { content: [{ type: 'text', text: 'probe ran' }] };
      },
    };
    const model = deferredFirstStep(store, finalTurn('answer to the correction'));
    const inbox = inboxContext();

    const pending = runLoop(inbox.ctx, servicesFor(store, model.brain, [probe]), input, runDoc.id, {
      sessionKey: input.sessionKey,
      agentId: input.agentId,
    }, NEVER_CANCELLED);
    // The correction arrives while the first model call is still thinking (queued in this session).
    inbox.push(steeringWake('steer-1', 'actually the correction'));
    model.resolveFirst(toolTurn('probe_effect'));

    expect(await pending).toBe('completed');
    // One run, one loop: the model re-ran on the refreshed context, never starting a second run.
    expect(model.steps()).toBe(2);
    expect((await store.list('runs', { limit: 10 })).items).toHaveLength(1);
    // The stale tool proposal had no effect.
    expect(executed).toEqual([]);
    // Only the post-correction answer is posted; the discarded turn's reply never appears.
    expect(await postedMessages(store)).toEqual(['answer to the correction']);
    // The rebuilt step-2 context sees the correction as a user turn.
    expect(model.contexts).toHaveLength(1);
    expect(JSON.stringify(model.contexts[0])).toContain('actually the correction');
    // The discarded turn left no unmatched assistant tool-call turn: the transcript is the steer
    // user message followed by the fresh answer, and never mentions the stale tool.
    const transcripts = (await store.list('transcripts', { limit: 50 })).items
      .slice()
      .sort((a, b) => a.seq - b.seq);
    expect(transcripts.map((entry) => entry.message.role)).toEqual(['user', 'assistant']);
    expect(transcripts[0]?.message).toMatchObject({ role: 'user', content: 'actually the correction' });
    expect(JSON.stringify(transcripts)).not.toContain('probe_effect');
  });

  it('continues the run when a steer lands during tool execution', async () => {
    const store = createMemoryStore();
    await store.put('runs', runDoc, { conversationId: runDoc.conversationId });
    const inbox = inboxContext();
    const silentFinish: Tool = {
      name: 'silent_finish',
      description: 'finishes quietly',
      parameters: {},
      replay: 'safe',
      sideEffect: false,
      async execute() {
        // The user corrects while this tool is running.
        inbox.push(steeringWake('steer-tool', 'keep going with this'));
        return { content: [{ type: 'text', text: 'done' }] };
      },
    };
    let calls = 0;
    const brain: Brain = {
      async buildContext(opts): Promise<BrainContext> {
        return { sessionKey: opts.sessionKey, agentId: opts.agentId };
      },
      async step(): Promise<AssistantTurn> {
        calls += 1;
        if (calls === 1) return toolTurn('silent_finish');
        return finalTurn('continued answer');
      },
      shouldCompact: () => false,
      async compact(ctx): Promise<BrainContext> {
        return ctx;
      },
    };

    const outcome = await runLoop(inbox.ctx, servicesFor(store, brain, [silentFinish]), input, runDoc.id, {
      sessionKey: input.sessionKey,
      agentId: input.agentId,
    }, NEVER_CANCELLED);
    expect(outcome).toBe('completed');
    // The correction drove a second model step.
    expect(calls).toBe(2);
    expect(await postedMessages(store)).toEqual(['continued answer']);
  });

  it('posts no final reply when a stop lands while draining in-flight steering', async () => {
    const store = createMemoryStore();
    await store.put('runs', runDoc, { conversationId: runDoc.conversationId });
    const brain: Brain = {
      async buildContext(opts): Promise<BrainContext> {
        return { sessionKey: opts.sessionKey, agentId: opts.agentId };
      },
      async step(): Promise<AssistantTurn> {
        return finalTurn('must not be posted');
      },
      shouldCompact: () => false,
      async compact(ctx): Promise<BrainContext> {
        return ctx;
      },
    };

    const outcome = await runLoop(inboxContext().ctx, servicesFor(store, brain), input, runDoc.id, {
      sessionKey: input.sessionKey,
      agentId: input.agentId,
    }, cancelOnSteerDrain());
    expect(outcome).toBe('stopped');
    expect(await postedMessages(store)).toEqual([]);
  });
});

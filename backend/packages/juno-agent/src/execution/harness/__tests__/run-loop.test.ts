import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, it, expect } from 'vitest';
import { RestatePromise, TerminalError } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type {
  AssistantTurn,
  Brain,
  BrainContext,
  Store,
  ToolRegistry,
  WakeEvent,
} from '../../../contracts/index.js';
import type { Run } from '@agent-desktop/public-contracts';
import { ModelTurnError } from '../../brain/model-turn-error.js';
import { createSendMessageTool } from '../../../modules/tools/tools/sendMessage.js';
import { NEVER_CANCELLED } from '../services/cancel.js';
import { runLoop } from '../services/run-loop.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';

const at = '2026-10-06T00:00:00.000Z';
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };

/** A model that returns the next pre-scripted turn on each step and a fixed context. */
class ScriptedTurns implements Brain {
  private index = 0;
  constructor(private readonly turns: AssistantTurn[]) {}

  async buildContext(): Promise<BrainContext> {
    return { sessionKey: 'agent-1:conv-1', agentId: 'agent-1' };
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
}

function sendText(id: string, text: string): AssistantTurn {
  return { text: '', toolCalls: [{ id, name: 'send_message', arguments: { kind: 'text', text } }], usage, stopReason: 'tool_calls' };
}

function final(text: string): AssistantTurn {
  return { text, toolCalls: [], usage, stopReason: 'stop' };
}

const wake: WakeEvent = {
  id: 'wake-1', ownerId: 'owner', agentId: 'agent-1', sessionKey: 'agent-1:conv-1', conversationId: 'conv-1',
  kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: 'hi' }, at,
  status: 'accepted',
};

const input: RunInput = { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake] };

function runContext(): RunContext {
  let ids = 0;
  return {
    rand: { uuidv4: () => `id${ids++}` },
    run: <T>(_name: string, action: () => Promise<T>): RestatePromise<T> => RestatePromise.resolve(action()),
    awakeable: <T>(): { id: string; promise: RestatePromise<T> } => ({
      id: 'awake',
      promise: RestatePromise.resolve(new Promise<T>(() => {})),
    }),
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
  };
}

function registryWith(store: Store): ToolRegistry {
  const tools = [createSendMessageTool({ store, enqueuer: new NoopEnqueuer() })];
  return {
    async forAgent() {
      return tools;
    },
    get: (name) => tools.find((tool) => tool.name === name),
  };
}

async function runScripted(turns: AssistantTurn[], options: { brain?: Brain; ctx?: RunContext; log?: RunServices['log']; store?: Store } = {}): Promise<string[]> {
  const store = options.store ?? createMemoryStore();
  const runDoc: Run = {
    id: 'run-1', agentId: 'agent-1', conversationId: 'conv-1', title: 'test', status: 'running', kind: 'chat',
    steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: at, lastActivityAt: at,
  };
  if (options.store === undefined) await store.put('runs', runDoc, { conversationId: runDoc.conversationId });
  const services: RunServices = {
    store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: options.brain ?? new ScriptedTurns(turns), toolRegistry: registryWith(store),
    ...(options.log === undefined ? {} : { log: options.log }),
  };
  const outcome = await runLoop(
    options.ctx ?? runContext(), services, input, 'run-1',
    { sessionKey: input.sessionKey, agentId: input.agentId }, NEVER_CANCELLED,
  );
  expect(outcome).toBe('completed');
  const items = await store.list('items', { orderBy: 'at', order: 'asc', limit: 50 });
  return items.items.map((item) => (item.type === 'agent_message' ? item.markdown : ''));
}

/** A brain that throws the given error from its first step, tracking later invocations. */
function throwingBrain(error: Error): { brain: Brain; calls: { count: number } } {
  const calls = { count: 0 };
  const brain: Brain = {
    async buildContext(): Promise<BrainContext> {
      return { sessionKey: 'agent-1:conv-1', agentId: 'agent-1' };
    },
    async step(): Promise<AssistantTurn> {
      calls.count += 1;
      throw error;
    },
    shouldCompact(): boolean {
      return false;
    },
    async compact(ctx: BrainContext): Promise<BrainContext> {
      return ctx;
    },
  };
  return { brain, calls };
}

async function runThrowingBrain(brain: Brain): Promise<{ store: Store; error: unknown }> {
  const store = createMemoryStore();
  // Production always runs with a run row; usage persistence requires it.
  await store.put('runs', {
    id: 'run-1', agentId: 'agent-1', conversationId: 'conv-1', title: 'test', status: 'running',
    kind: 'chat', steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: at, lastActivityAt: at,
  });
  const services: RunServices = {
    store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: registryWith(store),
  };
  const error = await runLoop(
    runContext(), services, input, 'run-1',
    { sessionKey: input.sessionKey, agentId: input.agentId }, NEVER_CANCELLED,
  ).then(() => undefined, (thrown: unknown) => thrown);
  return { store, error };
}

describe('run loop reply delivery', () => {
  it('delivers distinct send_message bubbles in call order, then the meaningful final', async () => {
    const messages = await runScripted([
      sendText('c1', 'Flight LH441 lands 18:05.'),
      sendText('c2', 'Gate B12, 25 minute delay.'),
      sendText('c3', 'Boarding starts in 10 minutes.'),
      final('All updates delivered.'),
    ]);
    expect(messages).toEqual([
      'Flight LH441 lands 18:05.',
      'Gate B12, 25 minute delay.',
      'Boarding starts in 10 minutes.',
      'All updates delivered.',
    ]);
  });

  it('drops a final reply that only repeats text send_message already delivered', async () => {
    const messages = await runScripted([
      sendText('c1', 'Flight LH441 lands 18:05.'),
      final('Flight LH441 lands 18:05.'),
    ]);
    expect(messages).toEqual(['Flight LH441 lands 18:05.']);
  });

  it('posts nothing when the model ends blank after send_message delivered the answer', async () => {
    const messages = await runScripted([
      sendText('c1', 'Flight LH441 lands 18:05.'),
      final(''),
    ]);
    expect(messages).toEqual(['Flight LH441 lands 18:05.']);
  });

  it('delivers two send_message text calls batched in one turn in call order', async () => {
    const messages = await runScripted([
      {
        text: '',
        toolCalls: [
          { id: 'c1', name: 'send_message', arguments: { kind: 'text', text: 'Flight LH441 lands 18:05.' } },
          { id: 'c2', name: 'send_message', arguments: { kind: 'text', text: 'Gate B12, 25 minute delay.' } },
        ],
        usage,
        stopReason: 'tool_calls',
      },
      final(''),
    ]);
    expect(messages).toEqual(['Flight LH441 lands 18:05.', 'Gate B12, 25 minute delay.']);
  });
});

describe('run loop terminal model failures', () => {
  it('surfaces a typed model stall as terminal with no turn, tool call or reply posted', async () => {
    const { brain } = throwingBrain(new ModelTurnError('stream_idle_timeout', 'model stream stalled'));
    const { store, error } = await runThrowingBrain(brain);
    expect(error).toBeInstanceOf(TerminalError);
    if (error instanceof TerminalError) {
      expect(error.message).toMatch(/stalled/);
      expect(error.metadata).toMatchObject({ code: 'stream_idle_timeout' });
    }
    expect((await store.list('transcripts', { limit: 50 })).items).toEqual([]);
    expect((await store.list('items', { limit: 50 })).items).toEqual([]);
    expect((await store.list('steps', { limit: 50 })).items).toEqual([]);
    // The failed attempt still burned active time: one unknown step is charged to the run row.
    const usage = (await store.get('runs', 'run-1'))?.usage;
    expect(usage?.steps).toBe(1);
    expect(Number.isFinite(usage?.computeSeconds)).toBe(true);
  });

  it('lets an ordinary transient model error propagate unchanged for retry', async () => {
    const transient = new Error('Model API error: 502 Timeout');
    const { brain } = throwingBrain(transient);
    const { store, error } = await runThrowingBrain(brain);
    expect(error).toBe(transient);
    expect(error).not.toBeInstanceOf(TerminalError);
    expect((await store.list('transcripts', { limit: 50 })).items).toEqual([]);
    expect((await store.list('items', { limit: 50 })).items).toEqual([]);
  });
});

describe('run loop refresh-before-compact', () => {
  it('compacts fresh long tool output before the next model call', async () => {
    const store = createMemoryStore();
    const runDoc: Run = {
      id: 'run-1', agentId: 'agent-1', conversationId: 'conv-1', title: 'test', status: 'running', kind: 'chat',
      steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
      startedAt: at, lastActivityAt: at,
    };
    await store.put('runs', runDoc, { conversationId: runDoc.conversationId });
    const log: string[] = [];
    const seen: string[] = [];
    let fresh = false;
    let compacted = false;
    const brain: Brain = {
      async buildContext(): Promise<BrainContext> {
        log.push('buildContext');
        fresh = true;
        return { sessionKey: 'agent-1:conv-1', agentId: 'agent-1', fresh: true };
      },
      async step(): Promise<AssistantTurn> {
        const tag = compacted ? 'compacted' : (fresh ? 'fresh-uncompacted' : 'stale');
        seen.push(tag);
        log.push('step:' + tag);
        if (!fresh) return sendText('c1', 'hello');
        return final('done');
      },
      shouldCompact(ctx: BrainContext): boolean {
        const isFresh = ctx.fresh === true;
        log.push(isFresh ? 'check:fresh-true' : 'check:stale-false');
        return isFresh;
      },
      async compact(_ctx: BrainContext): Promise<BrainContext> {
        log.push('compact');
        compacted = true;
        return { sessionKey: 'agent-1:conv-1', agentId: 'agent-1', compacted: true };
      },
    };
    const services: RunServices = {
      store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: registryWith(store),
    };
    const outcome = await runLoop(
      runContext(), services, input, 'run-1',
      { sessionKey: input.sessionKey, agentId: input.agentId }, NEVER_CANCELLED,
    );
    expect(outcome).toBe('completed');
    // The second model call must see the compacted fresh context, not the stale pre-tool one.
    expect(seen).toEqual(['stale', 'compacted']);
    expect(compacted).toBe(true);
    // Fresh rebuild precedes the compaction check that acts on it.
    expect(log.indexOf('buildContext')).toBeLessThan(log.indexOf('check:fresh-true'));
  });
});

describe('run loop timing logs', () => {
  /** A slow scripted model that reports provider stats the way the real provider does. */
  function timedTurns(turns: AssistantTurn[]): Brain {
    const scripted = new ScriptedTurns(turns);
    return {
      buildContext: () => scripted.buildContext(),
      shouldCompact: () => false,
      compact: async (ctx) => ctx,
      async step(_ctx, _tools, opts) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        opts.onStats?.({ hydrateMs: 1, prepMs: 2, firstEventMs: 10, firstTokenMs: 20, totalMs: 29, reasoningTokens: 5, images: 0, imageKB: 0 });
        return scripted.step();
      },
    };
  }

  /** A journaling context: a second run over the same journal replays every action instead of running it. */
  function journalingContext(journal: Map<string, unknown>): RunContext {
    let ids = 0;
    return {
      ...runContext(),
      rand: { uuidv4: () => `id${ids++}` },
      run: <T>(name: string, action: () => Promise<T>): RestatePromise<T> => {
        if (journal.has(name)) return RestatePromise.resolve(structuredClone(journal.get(name)) as T);
        return RestatePromise.resolve(action().then((value) => { journal.set(name, structuredClone(value)); return value; }));
      },
    };
  }

  it('logs one model call and one step timing line per real step, and nothing on replay', async () => {
    const lines: Array<{ message: string; fields: Record<string, unknown> }> = [];
    const log = (fields: Record<string, unknown>, message: string): void => { lines.push({ message, fields }); };
    const turns = [sendText('c1', 'Looking.'), final('Done.')];
    const journal = new Map<string, unknown>();
    const store = createMemoryStore();
    await store.put('runs', {
      id: 'run-1', agentId: 'agent-1', conversationId: 'conv-1', title: 'test', status: 'running', kind: 'chat',
      steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: at, lastActivityAt: at,
    }, { conversationId: 'conv-1' });
    await runScripted(turns, { brain: timedTurns(turns), ctx: journalingContext(journal), log, store });

    const calls = lines.filter((line) => line.message === 'model call').map((line) => line.fields);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ runId: 'run-1', step: 0, attempt: 'model:0', outcome: 'turn', hydrateMs: 1, prepMs: 2, firstTokenMs: 20, reasoningTokens: 5, inputTokens: 1, outputTokens: 1, toolCalls: 1 });
    const steps = lines.filter((line) => line.message === 'step timing').map((line) => line.fields);
    expect(steps.map((fields) => fields['step'])).toEqual([0, 1]);
    for (const fields of steps) {
      expect(fields['modelMs']).toBeGreaterThanOrEqual(25);
      expect(Number(fields['wallMs'])).toBeGreaterThanOrEqual(Number(fields['modelMs']) + Number(fields['toolMs']) + Number(fields['harnessMs']));
    }
    expect(JSON.stringify(lines)).not.toContain('Looking.');

    lines.length = 0;
    await runScripted(turns, { brain: timedTurns(turns), ctx: journalingContext(journal), log, store });
    expect(lines).toEqual([]);
  });
});

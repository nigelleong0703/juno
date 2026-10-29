import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, it, expect } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type {
  AssistantTurn,
  Brain,
  BrainContext,
  Store,
  Tool,
  ToolRegistry,
  ToolResult,
  WakeEvent,
} from '../../../contracts/index.js';
import type { Run } from '@agent-desktop/public-contracts';
import { createRunCancellation, type CancelSource } from '../services/cancel.js';
import { runLoop } from '../services/run-loop.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A cancel source whose `get()` returns an SDK-branded promise, like the real durable promise. */
function cancelSource(): { source: CancelSource; cancel: () => void } {
  let cancelled = false;
  let resolveSignal: (value: boolean) => void = () => {};
  const deferred = new Promise<boolean>((resolve) => {
    resolveSignal = resolve;
  });
  return {
    source: { peek: async () => cancelled, get: () => RestatePromise.resolve(deferred) },
    cancel: () => {
      cancelled = true;
      resolveSignal(true);
    },
  };
}

/** RunContext returning SDK-branded promises, so cancels race through RestatePromise.race. The unit
 * mock does not replay heterogeneous cached results (no casts); durable replay is covered by the
 * lead's real crash checks. */
function runContext(): RunContext {
  let seq = 0;
  return {
    rand: { uuidv4: () => `id-${seq++}` },
    run<T>(_name: string, action: () => Promise<T>): RestatePromise<T> {
      return RestatePromise.resolve(action());
    },
    awakeable<T>(): { id: string; promise: RestatePromise<T> } {
      return { id: 'awake', promise: RestatePromise.resolve(new Promise<T>(() => {})) };
    },
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
  };
}

const at = new Date().toISOString();
const wake: WakeEvent = {
  id: 'wake-1',
  ownerId: 'owner',
  agentId: 'agent-1',
  sessionKey: 'agent-1:conv-1',
  conversationId: 'conv-1',
  kind: 'user_message',
  origin: { type: 'user' },
  trusted: true,
  priority: 'user',
  payload: { text: 'hi' },
  at,
  status: 'accepted',
};
const input: RunInput = { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake] };
const run: Run = {
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

const context: BrainContext = { sessionKey: input.sessionKey, agentId: input.agentId };
const textTurn = (text: string): AssistantTurn => ({ text, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, stopReason: 'stop' });

function servicesFor(store: Store, brain: Brain, tools: Tool[] = []): RunServices {
  const registry: ToolRegistry = {
    forAgent: async () => tools,
    get: (name) => tools.find((tool) => tool.name === name),
  };
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: registry };
}

function brain(step: Brain['step']): Brain {
  return { buildContext: async () => context, shouldCompact: () => false, compact: async (c) => c, step };
}

describe('active cancellation', () => {
  it('aborts a cooperative model and posts no late reply', async () => {
    const store = createMemoryStore();
    await store.put('runs', run, { conversationId: run.conversationId });
    let aborted = false;
    const model = brain(async (_ctx, _tools, opts) => await new Promise<AssistantTurn>((resolve) => {
      const timer = setTimeout(() => resolve(textTurn('late reply')), 5000);
      opts.signal.addEventListener('abort', () => {
        aborted = true;
        clearTimeout(timer);
        resolve(textTurn('late reply'));
      }, { once: true });
    }));
    const { source, cancel } = cancelSource();
    const cancellation = createRunCancellation(source);
    const resultPromise = runLoop(runContext(), servicesFor(store, model), input, run.id, context, cancellation);
    setTimeout(cancel, 30);

    const result = await resultPromise;
    expect(result).toBe('stopped');
    expect((await store.list('items')).items.length).toBe(0);
    expect(aborted).toBe(true);
  });

  it('stops immediately when the model ignores its abort signal and suppresses the late completion', async () => {
    const store = createMemoryStore();
    await store.put('runs', run, { conversationId: run.conversationId });
    const model = brain(async () => await new Promise<AssistantTurn>((resolve) => {
      setTimeout(() => resolve(textTurn('late reply')), 2400);
    }));
    const { source, cancel } = cancelSource();
    const cancellation = createRunCancellation(source);
    const started = Date.now();
    const resultPromise = runLoop(runContext(), servicesFor(store, model), input, run.id, context, cancellation);
    setTimeout(cancel, 30);

    const result = await resultPromise;
    expect(result).toBe('stopped');
    expect(Date.now() - started).toBeLessThan(800);
    await sleep(2600);
    expect((await store.list('items')).items.length).toBe(0);
  });

  it('stops a non-cooperative tool: no second tool, no cached result, step stays failed', async () => {
    const store = createMemoryStore();
    await store.put('runs', run, { conversationId: run.conversationId });
    let started = 0;
    const slow: Tool = {
      name: 'slow_effect',
      description: 'slow',
      parameters: {},
      replay: 'never',
      sideEffect: true,
      execute: async (): Promise<ToolResult> => {
        started += 1;
        await sleep(300);
        return { content: [{ type: 'text', text: 'effect done' }] };
      },
    };
    let calls = 0;
    const model = brain(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          text: '',
          toolCalls: [
            { id: 'c1', name: 'slow_effect', arguments: {} },
            { id: 'c2', name: 'slow_effect', arguments: {} },
          ],
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
          stopReason: 'tool_calls',
        };
      }
      return textTurn('must not run');
    });
    const { source, cancel } = cancelSource();
    const cancellation = createRunCancellation(source);
    const resultPromise = runLoop(runContext(), servicesFor(store, model, [slow]), input, run.id, context, cancellation);
    setTimeout(cancel, 30);

    const result = await resultPromise;
    expect(result).toBe('stopped');
    await sleep(400);

    expect(started).toBe(1);
    const steps = (await store.list('steps')).items;
    expect(steps.length).toBe(1);
    expect(steps[0]?.status).toBe('failed');
    // The fence is preserved; the late result is never cached.
    expect(JSON.stringify(steps[0])).toContain('fencedAt');
    expect(JSON.stringify(steps[0])).not.toContain('"result"');
    expect((await store.list('items')).items.length).toBe(0);
    const transcripts = (await store.list('transcripts')).items;
    expect(transcripts.some((entry) => JSON.stringify(entry).includes('toolResult'))).toBe(false);
    // A stop cannot unsend a request: the step says the action is unconfirmed.
    expect(steps[0]?.output?.text).toContain('may already have taken effect');
  });

  it('says a stopped read-only tool changed nothing', async () => {
    const store = createMemoryStore();
    await store.put('runs', run, { conversationId: run.conversationId });
    const slow = (name: string, sideEffect: boolean): Tool => ({
      name, description: 'slow', parameters: {}, replay: sideEffect ? 'never' : 'safe', sideEffect,
      execute: async (): Promise<ToolResult> => { await sleep(300); return { content: [{ type: 'text', text: 'done' }] }; },
    });
    const model = brain(async () => ({
      text: '', toolCalls: [{ id: 'r1', name: 'slow_read', arguments: {} }],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, stopReason: 'tool_calls',
    }));
    const { source, cancel } = cancelSource();
    const cancellation = createRunCancellation(source);
    const resultPromise = runLoop(runContext(), servicesFor(store, model, [slow('slow_read', false), slow('slow_effect', true)]), input, run.id, context, cancellation);
    setTimeout(cancel, 30);
    expect(await resultPromise).toBe('stopped');
    await sleep(400);
    const steps = (await store.list('steps')).items;
    expect(steps[0]?.status).toBe('failed');
    expect(steps[0]?.output?.text).toContain('only reads, so nothing was changed');
  });
});

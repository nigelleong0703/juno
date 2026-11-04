import { describe, expect, it } from 'vitest';
import { DurablePromise } from '@agent-desktop/durable';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { AssistantTurn, Brain, BrainContext, Tool, WakeEvent } from '../../../contracts/index.js';
import { requestScopedStore } from '../../../owner-context.js';
import { NEVER_CANCELLED } from '../services/cancel.js';
import { runLoop } from '../services/run-loop.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';
import { CONVERSATION_TOO_LONG } from '../logic/plain-errors.js';

const AT = '2026-11-01T00:00:00.000Z';
const OWNER = 'owner-thrash';
const AGENT = 'agent-thrash';
const CONV = 'conv-thrash';
const KEY = AGENT + ':' + CONV;
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };

const wake: WakeEvent = {
  id: 'wake-1', ownerId: OWNER, agentId: AGENT, sessionKey: KEY, conversationId: CONV, kind: 'user_message', origin: { type: 'user' },
  trusted: true, priority: 'user', payload: { text: 'go' }, at: AT, status: 'accepted',
};
const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: KEY, wakeEvents: [wake] };

const noop: Tool = {
  name: 'noop', description: 'does nothing', parameters: { type: 'object', properties: {} }, replay: 'safe', sideEffect: false,
  execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
};

function context(): RunContext {
  let clock = 1000;
  const used = new Set<string>();
  let seq = 0;
  return {
    rand: { uuidv4: () => 'id-' + String(seq++) },
    localDate: { now: () => { clock += 200; return clock; } },
    run: <T>(name: string, action: () => Promise<T>): DurablePromise<T> => {
      if (used.has(name)) throw new Error('duplicate durable step: ' + name);
      used.add(name);
      return DurablePromise.resolve(action());
    },
    awakeable: <T>(): { id: string; promise: DurablePromise<T> } => { throw new Error('nobody waits here'); },
    drainInbox: () => DurablePromise.resolve<WakeEvent[]>([]),
  };
}

/** A model that calls a tool for `calls` steps and then answers; the brain asks to compact at the given steps and every compaction is committed. */
async function run(compactAt: number[], calls: number): Promise<{ outcome: string; compacted: number; error?: string; blockCause?: string }> {
  const raw = createMemoryStore();
  await raw.put('runs', {
    id: 'run-1', agentId: AGENT, conversationId: CONV, title: 'thrash', status: 'running', kind: 'chat', steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
  });
  let stepsSeen = 0;
  let compacted = 0;
  const brain: Brain = {
    buildContext: async (request): Promise<BrainContext> => ({ sessionKey: KEY, agentId: AGENT, compactionEpoch: Number(request.previousContext?.['compactionEpoch'] ?? 0) }),
    step: async (): Promise<AssistantTurn> => {
      stepsSeen += 1;
      return stepsSeen <= calls
        ? { text: '', toolCalls: [{ id: 'c' + String(stepsSeen), name: 'noop', arguments: {} }], usage, stopReason: 'tool_calls' }
        : { text: 'done', toolCalls: [], usage, stopReason: 'stop' };
    },
    // The step the loop is on is the number of model calls made so far: the check for step N comes before the N+1th call.
    shouldCompact: () => compactAt.includes(stepsSeen),
    compact: async (ctx) => { compacted += 1; return { ...ctx, compactionEpoch: Number(ctx['compactionEpoch'] ?? 0) + 1 }; },
  };
  const services: RunServices = {
    store: requestScopedStore(raw), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain,
    toolRegistry: { forAgent: async () => [noop], get: (name: string) => (name === 'noop' ? noop : undefined) },
  };
  const outcome = await runLoop(context(), services, input, 'run-1', { sessionKey: KEY, agentId: AGENT, compactionEpoch: 0 }, NEVER_CANCELLED);
  const stored = await raw.get('runs', 'run-1');
  return { outcome, compacted, ...(stored?.error === undefined ? {} : { error: stored.error }), ...(stored?.['blockCause'] === undefined ? {} : { blockCause: String(stored['blockCause']) }) };
}

describe('a run whose compactions do not help', () => {
  it('ends blocked with one plain sentence when it would compact a second time within five steps', async () => {
    const result = await run([0, 3], 10);
    expect(result).toMatchObject({ outcome: 'blocked', compacted: 1, error: CONVERSATION_TOO_LONG, blockCause: 'limit' });
  });

  it('compacts again once the first compaction is five steps behind it', async () => {
    const result = await run([0, 5], 8);
    expect(result).toMatchObject({ outcome: 'completed', compacted: 2 });
    expect(result.error).toBeUndefined();
  });
});

/**
 * Live run text for the voice bridge, through the real run loop: deltas only from a live provider attempt (never a journal replay),
 * a reset at the start of every attempt (so a retry discards its failed predecessor), the end of the turn with its tool-call count,
 * and the voice-run rule of the opening line (every spoken pre-tool line is also posted to the chat).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurablePromise } from '@agent-desktop/durable';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { AssistantTurn, Brain, BrainContext, LiveRunEvent, ToolRegistry, WakeEvent } from '../../../contracts/index.js';
import { ProviderFailureError } from '../../brain/model-failure.js';
import { NEVER_CANCELLED } from '../services/cancel.js';
import { ackStep } from '../services/final-reply.js';
import { coalescingLive, createLiveRuns } from '../../live-runs.js';
import { runLoop } from '../services/run-loop.js';
import type { RunContext, RunInput } from '../services/run-types.js';

const AT = '2026-11-04T00:00:00.000Z';
const AGENT = 'agent-voice';
const CONV = 'conv-voice';
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };
const emptyRegistry: ToolRegistry = { forAgent: async () => [], get: () => undefined };

function wake(itemId: string, channel?: string): WakeEvent {
  return {
    id: 'wake-1', ownerId: 'owner-voice', agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV,
    kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user',
    payload: { text: 'hello', addressed: 'direct', itemId, ...(channel === undefined ? {} : { channel }) }, at: AT, status: 'accepted',
  };
}
const inputFor = (itemId: string, channel?: string): RunInput => ({ agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [wake(itemId, channel)] });

function journalContext(journal: Map<string, unknown>): RunContext {
  const used = new Set<string>();
  let seq = 0;
  return {
    rand: { uuidv4: () => 'id-' + String(seq++) },
    run<T>(name: string, action: () => Promise<T>): DurablePromise<T> {
      if (used.has(name)) throw new Error('duplicate durable step: ' + name);
      used.add(name);
      if (journal.has(name)) return DurablePromise.resolve(structuredClone(journal.get(name)) as T);
      return DurablePromise.resolve(action().then((value) => {
        journal.set(name, structuredClone(value));
        return value;
      }));
    },
    awakeable<T>(): { id: string; promise: DurablePromise<T> } {
      return { id: 'awake-' + String(seq++), promise: DurablePromise.resolve(new Promise<T>(() => {})) };
    },
    drainInbox: () => DurablePromise.resolve<WakeEvent[]>([]),
    sleep: () => DurablePromise.resolve<void>(undefined),
  };
}

const runDoc = () => ({
  id: 'run-1', agentId: AGENT, conversationId: CONV, title: 'test', status: 'running', kind: 'chat', steps: [],
  usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
});

/** A provider that streams `chunks` through the real `onDelta` hook per attempt; failures are thrown after streaming. */
function streamingBrain(attempts: Array<{ chunks: string[]; fail?: Error }>, text: string): { brain: Brain; calls: () => number } {
  let calls = 0;
  const brain: Brain = {
    async buildContext(): Promise<BrainContext> { return { sessionKey: AGENT + ':' + CONV, agentId: AGENT }; },
    async step(_ctx, _tools, options): Promise<AssistantTurn> {
      const attempt = attempts[calls] ?? { chunks: [text] };
      calls += 1;
      for (const chunk of attempt.chunks) options?.onDelta?.(chunk);
      if (attempt.fail !== undefined) throw attempt.fail;
      return { text, toolCalls: [], usage, stopReason: 'stop' };
    },
    shouldCompact: () => false,
    async compact(ctx) { return ctx; },
  };
  return { brain, calls: () => calls };
}

async function drive(brain: Brain, journal: Map<string, unknown>, store = createMemoryStore()) {
  const seen: LiveRunEvent[] = [];
  const live = createLiveRuns();
  live.subscribe({ ownerId: 'owner-voice', conversationId: CONV, runId: 'run-1' }, (event) => { seen.push(event); });
  if (await store.get('runs', 'run-1') === null) await store.put('runs', runDoc() as never, { conversationId: CONV });
  const input = inputFor('voice-abc');
  const outcome = await runLoop(journalContext(journal), { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: emptyRegistry, live }, input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED);
  return { outcome, seen, store };
}

const summary = (events: LiveRunEvent[]) => events.map((event) => (event.type === 'run.text.delta' ? `delta:${event.text}` : event.type === 'run.text.end' ? `end:${String(event.toolCalls)}` : 'reset') + '@' + event.attempt);

describe('live run text from the harness', () => {
  it('a split deployment\'s worker sink coalesces tokens into a few ordered batches the coordinator relays into its hub', async () => {
    const batches: LiveRunEvent[][] = [];
    const sink = coalescingLive({ send: async (batch) => { batches.push(batch); }, flushMs: 5 });
    const scope = { ownerId: 'o', conversationId: CONV, agentId: AGENT, runId: 'run-1', attempt: 'model:0' };
    sink.publish({ ...scope, type: 'run.text.reset' });
    for (const token of ['He', 'l', 'lo', '.']) sink.publish({ ...scope, type: 'run.text.delta', text: token });
    sink.publish({ ...scope, type: 'run.text.end', toolCalls: 0 });
    await sink.stop();
    expect(batches).toHaveLength(1);
    expect(summary(batches[0] ?? [])).toEqual(['reset@model:0', 'delta:Hello.@model:0', 'end:0@model:0']);
    // The coordinator side: a transport that delivers the batch feeds the hub the stream route reads.
    const hub = createLiveRuns();
    const got: LiveRunEvent[] = [];
    hub.subscribe({ ownerId: 'o', conversationId: CONV, runId: 'run-1' }, (event) => { got.push(event); });
    for (const event of batches[0] ?? []) hub.publish(event);
    expect(summary(got)).toEqual(summary(batches[0] ?? []));
  });

  it('publishes a reset, each streamed delta and the end of the turn, scoped to the run, on a live call', async () => {
    const { brain } = streamingBrain([{ chunks: ['Hel', 'lo.'] }], 'Hello.');
    const { outcome, seen } = await drive(brain, new Map());
    expect(outcome).toBe('completed');
    expect(summary(seen)).toEqual(['reset@model:0', 'delta:Hel@model:0', 'delta:lo.@model:0', 'end:0@model:0']);
    expect(seen[0]).toMatchObject({ ownerId: 'owner-voice', conversationId: CONV, agentId: AGENT, runId: 'run-1' });
  });

  it('publishes nothing when the attempt is replayed from the journal', async () => {
    const journal = new Map<string, unknown>();
    const first = streamingBrain([{ chunks: ['Hello.'] }], 'Hello.');
    await drive(first.brain, journal);
    const replay = streamingBrain([{ chunks: ['Hello.'] }], 'Hello.');
    const { seen } = await drive(replay.brain, journal);
    expect(replay.calls()).toBe(0);
    expect(seen).toEqual([]);
  });

  it('resets at the start of a retried attempt so the consumer drops the failed attempt\'s partial text', async () => {
    const transient = new ProviderFailureError({ kind: 'transient', code: 'transient', message: 'Model request failed: 502' });
    const { brain } = streamingBrain([{ chunks: ['Partial'], fail: transient }, { chunks: ['Full.'] }], 'Full.');
    const { outcome, seen } = await drive(brain, new Map());
    expect(outcome).toBe('completed');
    expect(summary(seen)).toEqual(['reset@model:0', 'delta:Partial@model:0', 'reset@model:0:retry:1', 'delta:Full.@model:0:retry:1', 'end:0@model:0:retry:1']);
  });
});

describe('the opening line of a voice run', () => {
  async function post(itemId: string, tools: string[], channel?: string) {
    const store = createMemoryStore();
    await store.put('conversations', { id: CONV, kind: 'direct', agentIds: [AGENT] } as never);
    const journal = new Map<string, unknown>();
    const result = await ackStep(journalContext(journal), { store } as never, inputFor(itemId, channel), 3, 'Let me check.', tools, NEVER_CANCELLED, [], 'run-1');
    const items = await store.list('items', { where: { conversationId: CONV } });
    return { result, markdowns: items.items.map((item) => (item as { markdown?: string }).markdown) };
  }

  it('posts the spoken pre-tool line even where a text chat would stay quiet (a quiet tool, a reaction)', async () => {
    expect(await post('itm-1', ['memory_note'], 'voice')).toEqual({ result: 'posted', markdowns: ['Let me check.'] });
    expect(await post('itm-2', ['react'], 'voice')).toEqual({ result: 'posted', markdowns: ['Let me check.'] });
  });

  it('is decided by the explicit channel only: a voice- id without it is a text run', async () => {
    expect(await post('voice-abc', ['react'])).toEqual({ result: 'skipped', markdowns: [] });
  });

  it('keeps the text chat rules unchanged for a run a person typed', async () => {
    expect(await post('itm-typed', ['react'])).toEqual({ result: 'skipped', markdowns: [] });
  });
});

describe('the live hub for a subscriber that joins mid-run', () => {
  afterEach(() => vi.useRealTimers());
  const scope = { ownerId: 'o', conversationId: CONV, agentId: AGENT, runId: 'run-1' };
  const filter = { ownerId: 'o', conversationId: CONV, runId: 'run-1' };
  const delta = (text: string, attempt = 'model:0'): LiveRunEvent => ({ ...scope, attempt, type: 'run.text.delta', text });
  const reset = (attempt: string): LiveRunEvent => ({ ...scope, attempt, type: 'run.text.reset' });
  const join = (hub: ReturnType<typeof createLiveRuns>) => {
    const seen: LiveRunEvent[] = [];
    hub.subscribe(filter, (event) => { seen.push(event); });
    return seen;
  };

  it('replays the current attempt synchronously, then goes on live', () => {
    const hub = createLiveRuns();
    hub.publish(reset('model:0'));
    hub.publish(delta('Hel'));
    const late = join(hub);
    expect(summary(late)).toEqual(['reset@model:0', 'delta:Hel@model:0']);
    hub.publish(delta('lo'));
    expect(summary(late).at(-1)).toBe('delta:lo@model:0');
  });

  it('after a retry reset the late subscriber sees only the new attempt, and never another run or owner', () => {
    const hub = createLiveRuns();
    hub.publish(reset('model:0'));
    hub.publish(delta('Partial'));
    hub.publish(reset('model:0:retry:1'));
    hub.publish(delta('Full.', 'model:0:retry:1'));
    hub.publish({ ...scope, runId: 'run-2', attempt: 'model:0', type: 'run.text.delta', text: 'other run' });
    expect(summary(join(hub))).toEqual(['reset@model:0:retry:1', 'delta:Full.@model:0:retry:1']);
  });

  it('bounds the buffer per run (oldest deltas go first) and drops it after the TTL', () => {
    vi.useFakeTimers();
    const hub = createLiveRuns();
    hub.publish(reset('model:0'));
    for (let index = 0; index < 20; index += 1) hub.publish(delta(String(index % 10).repeat(8 * 1024)));
    const late = join(hub);
    const bytes = late.reduce((sum, event) => sum + (event.type === 'run.text.delta' ? event.text.length : 0), 0);
    expect(late[0]?.type).toBe('run.text.reset');
    expect(bytes).toBeLessThanOrEqual(64 * 1024);
    expect(bytes).toBeGreaterThan(32 * 1024);
    vi.advanceTimersByTime(31_000);
    expect(join(hub)).toEqual([]);
  });
});

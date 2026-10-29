/**
 * CT-boundary regression over the real Run loop (no live model call).
 *
 * A child run is a silent work item: its stored parent link on the journaled run row is the
 * only role authority, so the run loop suppresses every provisional preview frame while steps,
 * run updates and the internal transcript stay intact, and its settled final lands as childResult
 * (run.updated) — never an open-plan intermediate. A parent may not finish while a child it
 * spawned is live: the final is held, the transcript gains an actionable child-tools hint, and
 * only settled finals publish; repeated no-progress finals block truthfully while the children
 * keep running. Top-level runs stream and publish exactly as before.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type {
  AssistantTurn,
  Brain,
  BrainContext,
  Store,
  ToolRegistry,
  WakeEvent,
} from '../../../contracts/index.js';
import type { AgentEvent } from '@agent-desktop/public-contracts';
import { NEVER_CANCELLED } from '../services/cancel.js';
import { runLoop } from '../services/run-loop.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';
import { childSessionKey } from '../../../modules/tasks/child.js';
import { childPlanId, type ChildRun } from '../../../modules/tasks/childRead.js';
import { writeBoundTaskPlan } from '../../../modules/tasks/plan-write.js';

const AT = '2026-10-08T00:00:00.000Z';
const OWNER = 'owner-ctb';
const AGENT = 'agent-ctb';
const CONV = 'conv-ctb';
const PARENT = 'run-parent';
const CHILD = 'run-child';
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };

function wake(): WakeEvent {
  return {
    id: 'wake-1', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV,
    kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user',
    payload: { text: 'go', addressed: 'direct' }, at: AT, status: 'accepted',
  };
}
const parentInput: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [wake()] };
const childInput: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: childSessionKey(AGENT, CONV, CHILD), wakeEvents: [wake()] };

function runRow(id: string, overrides: Partial<ChildRun> = {}): ChildRun {
  return {
    id, agentId: AGENT, conversationId: CONV, title: 'work', status: 'running', kind: 'chat',
    steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: AT, lastActivityAt: AT, ...overrides,
  };
}

function childRow(): ChildRun {
  return runRow(CHILD, {
    parentRunId: PARENT,
    childSessionKey: childSessionKey(AGENT, CONV, CHILD),
    planId: childPlanId(AGENT, CONV, CHILD),
    kind: 'background',
    title: 'child work',
  });
}

function finalTurn(text: string): AssistantTurn {
  return { text, toolCalls: [], usage, stopReason: 'stop' };
}

/** A step-named durable context with a controllable inbox, so replay step names stay unique. */
function harnessContext(): RunContext {
  const used = new Set<string>();
  const inbox: WakeEvent[] = [];
  let seq = 0;
  return {
    rand: { uuidv4: () => 'id-' + String(seq++) },
    run<T>(name: string, action: () => Promise<T>): RestatePromise<T> {
      if (used.has(name)) throw new Error('duplicate durable step: ' + name);
      used.add(name);
      return RestatePromise.resolve(action());
    },
    awakeable<T>(): { id: string; promise: RestatePromise<T> } {
      return { id: 'awake-' + String(seq++), promise: RestatePromise.resolve(new Promise<T>(() => {})) };
    },
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>(inbox.splice(0, inbox.length)),
  };
}

/** A scripted brain: an optional side effect before each step and an optional streamed turn. */
function scriptedBrain(turns: AssistantTurn[], onStep?: (index: number) => Promise<void>): Brain {
  let index = 0;
  return {
    async buildContext(opts): Promise<BrainContext> {
      return { sessionKey: opts.sessionKey, agentId: opts.agentId };
    },
    async step(_ctx, _tools, stepOpts): Promise<AssistantTurn> {
      if (onStep !== undefined) await onStep(index);
      const turn = turns[index];
      index += 1;
      if (turn === undefined) throw new Error('script ran out of turns');
      return turn;
    },
    shouldCompact: () => false,
    async compact(ctx) {
      return ctx;
    },
  };
}

/** A brain whose one turn streams its text in chunks before the same turn is returned. */
function streamingBrain(chunks: string[], turn: AssistantTurn): Brain {
  return {
    async buildContext(opts): Promise<BrainContext> {
      return { sessionKey: opts.sessionKey, agentId: opts.agentId };
    },
    async step(_ctx, _tools, stepOpts): Promise<AssistantTurn> {
      for (const chunk of chunks) stepOpts.onDelta?.(chunk);
      return turn;
    },
    shouldCompact: () => false,
    async compact(ctx) {
      return ctx;
    },
  };
}

function servicesFor(store: Store, brain: Brain): RunServices {
  const registry: ToolRegistry = { forAgent: async () => [], get: () => undefined };
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: registry };
}

async function allEvents(raw: ReturnType<typeof createMemoryStore>): Promise<AgentEvent[]> {
  return (await raw.eventBus.since(0, 500)).map((entry) => entry.event);
}

/** Provisional previews only: attempt-scoped text frames and preview CUSTOM events. A committed reply is also standard TEXT_MESSAGE_* but carries no attempt id. */
function previews(all: AgentEvent[]): AgentEvent[] {
  return all.filter((event) => ((event.type === 'TEXT_MESSAGE_START' || event.type === 'TEXT_MESSAGE_CONTENT' || event.type === 'TEXT_MESSAGE_END') && event.metadata?.juno?.attemptId !== undefined)
    || (event.type === 'CUSTOM' && event.name.startsWith('juno.preview.')));
}

/* eslint-disable @typescript-eslint/no-unnecessary-condition -- the run.updated union read is a
   runtime record access; the member shape stays asserted by the event contract. */
function childResultsOf(all: AgentEvent[]): string[] {
  const results: string[] = [];
  for (const event of all) {
    if (event.type !== 'CUSTOM' || event.name !== 'juno.run.updated') continue;
    const run = event.value;
    const result = typeof run === 'object' && run !== null ? Reflect.get(run, 'childResult') : undefined;
    if (typeof result === 'string') results.push(result);
  }
  return results;
}
/* eslint-enable @typescript-eslint/no-unnecessary-condition */

async function postedMessages(raw: Store): Promise<string[]> {
  const messages: string[] = [];
  for (const item of (await raw.list('items', { limit: 200 })).items) {
    if (item.type === 'agent_message') messages.push(item.markdown);
  }
  return messages;
}

async function transcriptText(raw: Store): Promise<string> {
  return JSON.stringify((await raw.list('transcripts', { limit: 200 })).items);
}

async function seedRuns(store: ReturnType<typeof createMemoryStore>): Promise<void> {
  await store.put('runs', runRow(PARENT), { conversationId: CONV });
  await store.put('runs', childRow(), { conversationId: CONV });
}

describe('child chat boundary over the real run loop', () => {
  it('a child run emits no preview frame; steps, run updates and its internal transcript stay real', async () => {
    const store = createMemoryStore();
    await seedRuns(store);
    const brain = streamingBrain(['child w', 'ork done'], finalTurn('child work done'));
    const outcome = await runLoop(harnessContext(), servicesFor(store, brain), childInput, CHILD, { sessionKey: childInput.sessionKey, agentId: AGENT }, NEVER_CANCELLED);
    expect(outcome).toBe('completed');
    // Silent preview: a child run publishes no message.preview frame at all.
    expect(previews(await allEvents(store))).toEqual([]);
    // The settled child final is delivered as childResult through a real run.updated event.
    expect(childResultsOf(await allEvents(store))).toEqual(['child work done']);
    const doc: ChildRun | null = await store.get('runs', CHILD);
    expect(doc?.childResult).toBe('child work done');
    // Steps/run updates kept happening: the frozen step was charged to the run.
    expect(doc?.usage.steps).toBeGreaterThan(0);
    // The model's internal transcript keeps the assistant turn.
    expect(await transcriptText(store)).toContain('child work done');
  });

  it('a top-level run previews nothing and posts its final whole as a bubble', async () => {
    const store = createMemoryStore();
    await store.put('runs', runRow(PARENT), { conversationId: CONV });
    const brain = streamingBrain(['root ', 'answer'], finalTurn('root answer'));
    const outcome = await runLoop(harnessContext(), servicesFor(store, brain), parentInput, PARENT, { sessionKey: parentInput.sessionKey, agentId: AGENT }, NEVER_CANCELLED);
    expect(outcome).toBe('completed');
    expect(previews(await allEvents(store))).toEqual([]);
    expect(await postedMessages(store)).toEqual(['root answer']);
    // A top-level run is not a child result carrier.
    expect(childResultsOf(await allEvents(store))).toEqual([]);
  });

  it('a parent with a live child holds its final with a child-tools hint and finishes once the child settles', async () => {
    const store = createMemoryStore();
    await seedRuns(store);
    const stepped: number[] = [];
    const brain = scriptedBrain([finalTurn('waiting for the child'), finalTurn('all done now')], async (index) => {
      stepped.push(index);
      if (index === 1) await store.patch('runs', CHILD, { status: 'completed' });
    });
    const outcome = await runLoop(harnessContext(), servicesFor(store, brain), parentInput, PARENT, { sessionKey: parentInput.sessionKey, agentId: AGENT }, NEVER_CANCELLED);
    expect(outcome).toBe('completed');
    // The held final never published; only the post-settlement final became a bubble.
    expect(await postedMessages(store)).toEqual(['all done now']);
    expect(stepped).toEqual([0, 1]);
    // The hold hint names the child tools and stays in the transcript.
    const transcript = await transcriptText(store);
    expect(transcript).toContain('child_results');
    expect(transcript).toContain('child_wait');
    expect(transcript).toContain('child_cancel');
    expect(transcript).toContain('waiting for the child');
  });

  it('repeated finals over the same live child block truthfully and never cancel the child', async () => {
    const store = createMemoryStore();
    await seedRuns(store);
    const brain = scriptedBrain([finalTurn('still waiting'), finalTurn('still waiting'), finalTurn('still waiting'), finalTurn('still waiting'), finalTurn('still waiting')]);
    const outcome = await runLoop(harnessContext(), servicesFor(store, brain), parentInput, PARENT, { sessionKey: parentInput.sessionKey, agentId: AGENT }, NEVER_CANCELLED);
    expect(outcome).toBe('blocked');
    const doc = await store.get('runs', PARENT);
    expect(doc?.error).toContain('child task(s) still active');
    expect(doc?.error).toContain(CHILD);
    // The stalled block is a terminal decision, not an auto-cancel: the child stays live.
    const child = await store.get('runs', CHILD);
    expect(child?.status).toBe('running');
    // The held finals stayed silent; the blocked explanatory final is the one that published.
    expect(await postedMessages(store)).toEqual(['still waiting']);
    expect((await transcriptText(store)).split('[internal child check]')).toHaveLength(4);
  });

  it('a child saves its final result only when its own plan settles, never on an open-plan final', async () => {
    const store = createMemoryStore();
    await seedRuns(store);
    await writeBoundTaskPlan(store, AGENT, CONV, CHILD, [{ id: 'ct1', text: 'Do child work', status: 'pending' }], false);
    const brain = scriptedBrain([finalTurn('intermediate plan note'), finalTurn('final answer done')], async (index) => {
      if (index === 1) {
        await writeBoundTaskPlan(store, AGENT, CONV, CHILD, [{ id: 'ct1', text: 'Do child work', status: 'done' }], false);
      }
    });
    const outcome = await runLoop(harnessContext(), servicesFor(store, brain), childInput, CHILD, { sessionKey: childInput.sessionKey, agentId: AGENT }, NEVER_CANCELLED);
    expect(outcome).toBe('completed');
    expect(previews(await allEvents(store))).toEqual([]);
    expect(await postedMessages(store)).toEqual([]);
    // Only the settled final became the child result; the intermediate one is gone.
    expect(childResultsOf(await allEvents(store))).toEqual(['final answer done']);
    const doc: ChildRun | null = await store.get('runs', CHILD);
    expect(doc?.childResult).toBe('final answer done');
  });
});

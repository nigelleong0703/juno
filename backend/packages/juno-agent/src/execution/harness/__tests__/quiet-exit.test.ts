/**
 * The quiet exit (BACKEND §3.3a): `finish_quietly` is offered only in a run nobody is waiting on (its root origin is unattended and not a
 * platform chat). Calling it ends the run completed with nothing delivered, whatever text the run also wrote, and the reason becomes the
 * task's result line. Driven through the production run loop with the real tool.
 */
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import type { Run, RunOrigin } from '@agent-desktop/public-contracts';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { AssistantTurn, Brain, BrainContext, Tool, ToolRegistry, WakeEvent } from '../../../contracts/index.js';
import { createToolSearchTool } from '../../../modules/tools/tools/toolSearch.js';
import { createFinishQuietlyTool } from '../../../modules/tools/tools/finishQuietly.js';
import { childPlanId, childSessionKey } from '../../../modules/tasks/childRead.js';
import { runAsTask } from '../../../modules/tasks/work-view.js';
import { offersQuietExit, quietEligibleOf } from '../logic/run-origin.js';
import { NEVER_CANCELLED } from '../services/cancel.js';
import { runLoop } from '../services/run-loop.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';

const AT = '2026-10-29T08:00:00.000Z';
const AGENT = 'agent-quiet';
const CONV = 'conv-quiet';
const OWNER = 'owner-quiet';
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };
const QUIET = { id: 'call_q', name: 'finish_quietly', arguments: { reason: 'No new AI news since yesterday\'s post' } };

const routineWake: WakeEvent = {
  id: 'wake-1', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV, kind: 'routine',
  origin: { type: 'automation', id: 'rtn-1' }, trusted: true, priority: 'background', payload: { text: 'Post AI news if there is any', routineId: 'rtn-1', occurrenceAt: AT }, at: AT, status: 'accepted',
};
const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [routineWake] };

const routine: RunOrigin = { type: 'routine', routineId: 'rtn-1', occurrenceAt: AT };
const owner: RunOrigin = { type: 'owner_message', conversationId: CONV };
const channel = (speaker: 'owner' | 'member' | 'stranger'): RunOrigin => ({ type: 'channel', channel: 'telegram', conversationId: CONV, speaker });
const system: RunOrigin = { type: 'system', wakeKind: 'goal_checkin' };
const child: RunOrigin = { type: 'parent_run', runId: 'run-parent' };

const turn = (text: string, ...calls: AssistantTurn['toolCalls']): AssistantTurn => ({ text, toolCalls: calls, usage, stopReason: calls.length > 0 ? 'tool_calls' : 'stop' });

function runRow(origin: RunOrigin, rootOrigin?: RunOrigin, quietEligible = true): Run & { quietEligible: boolean } {
  return {
    quietEligible,
    id: 'run-1', agentId: AGENT, conversationId: CONV, title: 'Routine: AI news', status: 'running', kind: 'routine', origin, ...(rootOrigin === undefined ? {} : { rootOrigin }),
    ...(origin.type === 'routine' ? { routineId: origin.routineId } : {}),
    steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
  };
}

function context(): RunContext {
  return {
    rand: { uuidv4: () => 'id-' + Math.random().toString(36).slice(2) },
    run: <T>(_name: string, action: () => Promise<T>): RestatePromise<T> => RestatePromise.resolve(action()),
    awakeable: <T>(): { id: string; promise: RestatePromise<T> } => ({ id: 'awake', promise: RestatePromise.resolve(new Promise<T>(() => {})) }),
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
  };
}

async function drive(row: Run, turns: AssistantTurn[], parent?: Run) {
  const store = createMemoryStore();
  if (parent !== undefined) await store.put('runs', parent, { conversationId: CONV });
  await store.put('agents', { id: AGENT, ownerId: OWNER, name: 'Nova' } as never);
  await store.put('conversations', { id: CONV, kind: 'direct', memberIds: [OWNER], agentIds: [AGENT], unreadCount: 0 } as never);
  await store.put('runs', row, { conversationId: CONV });
  const offered: Array<{ names: string[]; deferred: Record<string, boolean | undefined> }> = [];
  let index = 0;
  const brain: Brain = {
    async buildContext(): Promise<BrainContext> {
      return { sessionKey: input.sessionKey, agentId: AGENT, modelSelection: { modelId: 'm', baseUrl: 'https://x/v1', supportsImages: false } };
    },
    async step(_ctx, tools): Promise<AssistantTurn> {
      offered.push({ names: tools.map((tool) => tool.name), deferred: Object.fromEntries(tools.map((tool) => [tool.name, tool.deferLoading])) });
      const next = turns[Math.min(index, turns.length - 1)];
      index += 1;
      if (next === undefined) throw new Error('no scripted turn');
      return next;
    },
    shouldCompact: () => false,
    async compact(ctx) { return ctx; },
  };
  const tools: Tool[] = [{ ...createFinishQuietlyTool(), deferLoading: true }];
  const registry: ToolRegistry = { forAgent: async () => tools, get: (name) => tools.find((tool) => tool.name === name) };
  const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: registry };
  const outcome = await runLoop(context(), services, { ...input }, 'run-1', await brain.buildContext({ agentId: AGENT, conversationId: CONV, sessionKey: input.sessionKey, wake: [routineWake] }), NEVER_CANCELLED);
  const items = (await store.list('items', { limit: 50 })).items;
  return { outcome, offered, items, store, calls: index };
}

describe('who is offered finish_quietly', () => {
  it.each([
    ['a routine run', routine, undefined, true],
    ['a system wake (goal check-in)', system, undefined, true],
    ['a child of a routine', child, routine, true],
    ['a child of a system wake', child, system, true],
    ['the owner typing in the app', owner, undefined, false],
    ['a child of the owner\'s message', child, owner, false],
    ['the owner speaking in a platform chat', channel('owner'), undefined, false],
    ['a stranger in a platform chat', channel('stranger'), undefined, false],
    ['a member in a platform chat', channel('member'), undefined, false],
    ['a child of a stranger\'s message', child, channel('stranger'), false],
    // Marked eligible at start but attended by origin: the origin still refuses (belt and braces).
    ['a run marked eligible whose root is the owner', owner, undefined, false],
    ['a routine run whose starting wake was not on the allowlist', routine, undefined, false, false],
  ])('%s', async (_name, origin, rootOrigin, expected, eligible = true) => {
    expect(offersQuietExit(runRow(origin, rootOrigin, eligible))).toBe(expected);
    const { offered } = await drive(runRow(origin, rootOrigin, eligible), [turn('done')]);
    const first = offered[0];
    expect(first?.names.includes('finish_quietly')).toBe(expected);
    // Shown with the core tools when offered (not behind tool_search).
    if (expected) expect(first?.deferred['finish_quietly']).toBe(false);
  });

  it('is not offered to a run with no recorded origin', () => {
    expect(offersQuietExit(undefined)).toBe(false);
    expect(offersQuietExit(null)).toBe(false);
    expect(offersQuietExit({})).toBe(false);
  });

  it('refuses a call in a run where someone is waiting, even when reached by name', async () => {
    const tool = createFinishQuietlyTool();
    const store = createMemoryStore();
    await store.put('runs', runRow(owner), { conversationId: CONV });
    const refused = await tool.execute({ reason: 'nothing' }, { ownerId: OWNER, agentId: AGENT, conversationId: CONV, runId: 'run-1', store, step: (_name: string, fn: () => Promise<unknown>) => fn() } as never);
    expect(refused.isError).toBe(true);
    expect(refused.details).toBeUndefined();
  });
});

describe('which starting wakes are marked quiet-eligible (allowlist, fail closed)', () => {
  const wake = (kind: string, origin: WakeEvent['origin'], payload: Record<string, unknown> = {}): WakeEvent =>
    ({ ...routineWake, kind: kind as WakeEvent['kind'], origin, payload: { text: 'x', ...payload } });
  const automation = { type: 'automation' as const, id: 'a-1' };
  it.each([
    ['scheduled routine fire', wake('routine', automation, { routineId: 'rtn-1' }), true],
    ['monitor fire', wake('monitor', { type: 'system' }, { routineId: 'rtn-1' }), true],
    ['monitor system notice', wake('monitor', { type: 'system' }, { routineId: 'rtn-1', notice: true }), false],
    ['automation-sent webhook', wake('webhook', automation, { routineId: 'rtn-1' }), true],
    ['scheduled goal check-in', wake('goal_checkin', automation, { reason: 'scheduled' }), true],
    ['daily ideas notice (proactive check)', wake('goal_checkin', automation, { reason: 'proactive' }), true],
    ['manual "Check now" check-in', wake('goal_checkin', automation, { reason: 'manual' }), false],
    ['goal plan and deadline check-ins', wake('goal_checkin', automation, { reason: 'deadline' }), false],
    ['onboarding', wake('onboarding', { type: 'system' }), false],
    ['peer agent message', wake('room_mention', { type: 'agent', id: 'peer' }), false],
    ['request_resolved', wake('request_resolved', { type: 'system' }), false],
    ['owner message', wake('user_message', { type: 'user' }), false],
    ['a wake kind nobody classified', wake('capability_ready', { type: 'system' }), false],
    ['a timer with no run behind it', wake('timer', { type: 'system' }), false],
  ])('%s', async (_name, event, expected) => {
    expect(await quietEligibleOf(createMemoryStore(), event)).toBe(expected);
  });

  it('a child task and a completion wake follow the run they continue', async () => {
    const store = createMemoryStore();
    await store.put('runs', { ...runRow(routine), id: 'run-quiet' } as Run, { conversationId: CONV });
    await store.put('runs', { ...runRow(owner, undefined, false), id: 'run-chat' } as Run, { conversationId: CONV });
    expect(await quietEligibleOf(store, wake('child_task', { type: 'system' }, { parentRunId: 'run-quiet' }))).toBe(true);
    expect(await quietEligibleOf(store, wake('child_task', { type: 'system' }, { parentRunId: 'run-chat' }))).toBe(false);
    expect(await quietEligibleOf(store, wake('task_done', { type: 'system' }, { originRunId: 'run-quiet' }))).toBe(true);
    expect(await quietEligibleOf(store, wake('hand_back', { type: 'system' }, { originRunId: 'run-chat' }))).toBe(false);
    expect(await quietEligibleOf(store, wake('timer', { type: 'system' }, { originRunId: 'run-gone' }))).toBe(false);
  });
});

describe('discovery of finish_quietly', () => {
  const search = async (row: Run & { quietEligible: boolean }, query: string): Promise<string> => {
    const store = createMemoryStore();
    await store.put('runs', row, { conversationId: CONV });
    const quiet: Tool = { ...createFinishQuietlyTool(), deferLoading: true };
    const other: Tool = { name: 'feed_post', description: 'Publish a post to the feed.', parameters: { type: 'object' }, replay: 'safe', sideEffect: true, deferLoading: true, execute: async () => ({ content: [] }) };
    const source = { all: async () => [quiet, other], visible: async () => new Set<string>() };
    const ctx = { ownerId: OWNER, agentId: AGENT, conversationId: CONV, runId: 'run-1', store, signal: new AbortController().signal, toolSearch: 'responses-tool-search' } as never;
    const result = await createToolSearchTool(source).execute({ query }, ctx);
    return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  };

  it('is never returned to a run that does not have it', async () => {
    expect(await search(runRow(owner, undefined, false), 'finish quietly end the run silently')).not.toContain('finish_quietly');
  });

  it('is reported as already in the list of a run that has it', async () => {
    expect(await search(runRow(routine), 'finish quietly end the run silently')).toContain('Already in your list: finish_quietly');
  });
});

describe('ending a run quietly', () => {
  it('completes with nothing delivered, the reason on the run and as the task line, and drops the text written beside the call', async () => {
    const { outcome, items, store, offered } = await drive(runRow(routine), [turn('(empty)', QUIET)]);
    expect(outcome).toBe('completed');
    expect(items).toEqual([]);
    expect((await store.get('conversations', CONV))?.unreadCount).toBe(0);
    // The run ends at the call: no further model turn.
    expect(offered).toHaveLength(1);
    const stored = await store.get('runs', 'run-1');
    expect(stored?.quietReason).toBe('No new AI news since yesterday\'s post');
    expect(runAsTask({ ...stored!, status: 'completed', finishedAt: AT }, { routine: null, waitingFor: 'owner_input' })?.resultLine).toBe('Nothing to report: No new AI news since yesterday\'s post');
  });

  it('still delivers a normal final reply, once', async () => {
    const { outcome, items, store } = await drive(runRow(routine), [turn('Chip launch moved to Friday.')]);
    expect(outcome).toBe('completed');
    expect(items.map((item) => (item as { markdown?: string }).markdown)).toEqual(['Chip launch moved to Friday.']);
    expect((await store.get('runs', 'run-1'))?.quietReason).toBeUndefined();
  });

  it('reports a child run\'s quiet reason to its parent instead of staying silent', async () => {
    const row = { ...runRow(child, routine), kind: 'background', parentRunId: 'run-parent', planId: childPlanId(AGENT, CONV, 'run-1'), childSessionKey: childSessionKey(AGENT, CONV, 'run-1') } as Run;
    const { outcome, items, store } = await drive(row, [turn('', QUIET)], { ...runRow(routine), id: 'run-parent' });
    expect(outcome).toBe('completed');
    expect(items).toEqual([]);
    expect((await store.get('runs', 'run-1') as { childResult?: string }).childResult).toBe('Nothing to report: No new AI news since yesterday\'s post');
  });
});

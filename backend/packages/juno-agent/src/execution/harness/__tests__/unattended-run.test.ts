/**
 * Delivery split (BACKEND §3.3b): in a run nobody is waiting on (its root origin is unattended and not a platform chat) the final text is a
 * record line, never a message, and the model reaches the person only through send_message / feed_post. Driven through the production run
 * loop with the real send_message tool.
 */
import { describe, expect, it } from 'vitest';
import { DurablePromise } from '@agent-desktop/durable';
import type { Run, RunOrigin } from '@agent-desktop/public-contracts';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { AssistantTurn, Brain, BrainContext, Tool, ToolRegistry, WakeEvent } from '../../../contracts/index.js';
import { createSendMessageTool } from '../../../modules/tools/tools/sendMessage.js';
import { subagentPlanId, subagentSessionKey } from '../../../modules/tasks/subagentRead.js';
import { runAsTask } from '../../../modules/tasks/work-view.js';
import { nobodyWaitingOf, speaksOnlyBySend } from '../logic/run-origin.js';
import { NEVER_CANCELLED } from '../services/cancel.js';
import { runLoop } from '../services/run-loop.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';

const AT = '2026-10-29T08:00:00.000Z';
const AGENT = 'agent-quiet';
const CONV = 'conv-quiet';
const OWNER = 'owner-quiet';
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };
const send = (purpose: string, text: string): AssistantTurn['toolCalls'][number] => ({ id: 'call_s', name: 'send_message', arguments: { kind: 'text', purpose, text } });

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

function runRow(origin: RunOrigin, rootOrigin?: RunOrigin, nobodyWaiting = true): Run & { nobodyWaiting: boolean } {
  return {
    nobodyWaiting,
    id: 'run-1', agentId: AGENT, conversationId: CONV, title: 'Routine: AI news', status: 'running', kind: 'routine', origin, ...(rootOrigin === undefined ? {} : { rootOrigin }),
    ...(origin.type === 'routine' ? { routineId: origin.routineId } : {}),
    steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
  };
}

function context(inbox: () => WakeEvent[] = () => []): RunContext {
  return {
    rand: { uuidv4: () => 'id-' + Math.random().toString(36).slice(2) },
    run: <T>(_name: string, action: () => Promise<T>): DurablePromise<T> => DurablePromise.resolve(action()),
    awakeable: <T>(): { id: string; promise: DurablePromise<T> } => ({ id: 'awake', promise: DurablePromise.resolve(new Promise<T>(() => {})) }),
    drainInbox: () => DurablePromise.resolve<WakeEvent[]>(inbox()),
  };
}

/** `steer`: a message that reaches the run once the model has been called (a person writing into it). */
async function drive(row: Run, turns: AssistantTurn[], parent?: Run, wake: WakeEvent = routineWake, steer?: WakeEvent) {
  const store = createMemoryStore();
  if (parent !== undefined) await store.put('runs', parent, { conversationId: CONV });
  await store.put('agents', { id: AGENT, ownerId: OWNER, name: 'Nova' } as never);
  await store.put('conversations', { id: CONV, kind: 'direct', memberIds: [OWNER], agentIds: [AGENT], unreadCount: 0 } as never);
  await store.put('runs', row, { conversationId: CONV });
  const results: string[] = [];
  let index = 0;
  const brain: Brain = {
    async buildContext(): Promise<BrainContext> {
      return { sessionKey: input.sessionKey, agentId: AGENT, modelSelection: { modelId: 'm', baseUrl: 'https://x/v1', supportsImages: false } };
    },
    async step(): Promise<AssistantTurn> {
      const next = turns[Math.min(index, turns.length - 1)];
      index += 1;
      if (next === undefined) throw new Error('no scripted turn');
      return next;
    },
    shouldCompact: () => false,
    async compact(ctx) { return ctx; },
  };
  const enqueuer = new NoopEnqueuer();
  const tools: Tool[] = [createSendMessageTool({ store, enqueuer })];
  const registry: ToolRegistry = { forAgent: async () => tools, get: (name) => tools.find((tool) => tool.name === name) };
  const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer, brain, toolRegistry: registry };
  let steered = false;
  const inbox = (): WakeEvent[] => {
    if (steer === undefined || steered || index === 0) return [];
    steered = true;
    return [steer];
  };
  const outcome = await runLoop(context(inbox), services, { ...input, wakeEvents: [wake] }, 'run-1', await brain.buildContext({ agentId: AGENT, conversationId: CONV, sessionKey: input.sessionKey, wake: [wake] }), NEVER_CANCELLED);
  const items = (await store.list('items', { limit: 50 })).items;
  for (const step of (await store.get('runs', 'run-1'))?.steps ?? []) results.push(step.output?.summary ?? step.output?.text ?? '');
  return { outcome, items, store, results, modelCalls: index };
}

describe('which runs speak only through send_message', () => {
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
    // Marked at start but attended by origin: the origin still refuses (belt and braces).
    ['a run marked nobody-waiting whose root is the owner', owner, undefined, false],
    ['a routine run whose starting wake was not on the allowlist', routine, undefined, false, false],
  ])('%s', (_name, origin, rootOrigin, expected, marked = true) => {
    expect(speaksOnlyBySend(runRow(origin, rootOrigin, marked))).toBe(expected);
  });

  it('is false for a run with no recorded origin', () => {
    expect(speaksOnlyBySend(undefined)).toBe(false);
    expect(speaksOnlyBySend(null)).toBe(false);
    expect(speaksOnlyBySend({})).toBe(false);
  });
});

describe('which starting wakes are marked nobody-waiting (allowlist, fail closed)', () => {
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
    ['the outbox telling the agent a message was not delivered', wake('hand_back', { type: 'system', label: 'delivery failed' }, { source: 'delivery_failed' }), true],
    ['another hand-back from the system', wake('hand_back', { type: 'system' }, { source: 'meeting' }), false],
    ['onboarding', wake('onboarding', { type: 'system' }), false],
    ['peer agent message', wake('room_mention', { type: 'agent', id: 'peer' }), false],
    ['request_resolved', wake('request_resolved', { type: 'system' }), false],
    ['owner message', wake('user_message', { type: 'user' }), false],
    ['a wake kind nobody classified', wake('capability_ready', { type: 'system' }), false],
    ['a timer with no run behind it', wake('timer', { type: 'system' }), false],
  ])('%s', async (_name, event, expected) => {
    expect(await nobodyWaitingOf(createMemoryStore(), event)).toBe(expected);
  });

  it('a child task and a completion wake follow the run they continue', async () => {
    const store = createMemoryStore();
    await store.put('runs', { ...runRow(routine), id: 'run-quiet' } as Run, { conversationId: CONV });
    await store.put('runs', { ...runRow(owner, undefined, false), id: 'run-chat' } as Run, { conversationId: CONV });
    expect(await nobodyWaitingOf(store, wake('subagent_task', { type: 'system' }, { parentRunId: 'run-quiet' }))).toBe(true);
    expect(await nobodyWaitingOf(store, wake('subagent_task', { type: 'system' }, { parentRunId: 'run-chat' }))).toBe(false);
    expect(await nobodyWaitingOf(store, wake('task_done', { type: 'system' }, { originRunId: 'run-quiet' }))).toBe(true);
    expect(await nobodyWaitingOf(store, wake('hand_back', { type: 'system' }, { originRunId: 'run-chat' }))).toBe(false);
    expect(await nobodyWaitingOf(store, wake('timer', { type: 'system' }, { originRunId: 'run-gone' }))).toBe(false);
  });
});

describe('the final text of a run nobody is waiting on', () => {
  it('is never delivered: no item, no unread, and it becomes the task\'s result line', async () => {
    const { outcome, items, store } = await drive(runRow(routine), [turn('No new AI news since yesterday\'s post')]);
    expect(outcome).toBe('completed');
    expect(items).toEqual([]);
    expect((await store.get('conversations', CONV))?.unreadCount).toBe(0);
    const stored = await store.get('runs', 'run-1');
    expect(stored?.record).toBe('No new AI news since yesterday\'s post');
    expect(runAsTask({ ...stored!, status: 'completed', finishedAt: AT }, { routine: null, waitingFor: 'owner_input' })?.resultLine).toBe('No new AI news since yesterday\'s post');
  });

  it('an empty final text keeps no record line and changes nothing else', async () => {
    const { outcome, items, store } = await drive(runRow(routine), [turn('  ')]);
    expect(outcome).toBe('completed');
    expect(items).toEqual([]);
    expect((await store.get('runs', 'run-1'))?.record).toBeUndefined();
  });

  it('is still the reply in a run someone waits on', async () => {
    const { outcome, items, store } = await drive(runRow(owner, undefined, false), [turn('Chip launch moved to Friday.')]);
    expect(outcome).toBe('completed');
    expect(items.map((item) => (item as { markdown?: string }).markdown)).toEqual(['Chip launch moved to Friday.']);
    expect((await store.get('runs', 'run-1'))?.record).toBeUndefined();
  });

  it('a child run of a routine still hands its text to the parent as the child result', async () => {
    const row = { ...runRow(child, routine), kind: 'background', parentRunId: 'run-parent', planId: subagentPlanId(AGENT, CONV, 'run-1'), childSessionKey: subagentSessionKey(AGENT, CONV, 'run-1') } as Run;
    const { outcome, items, store } = await drive(row, [turn('Found three stories')], { ...runRow(routine), id: 'run-parent' });
    expect(outcome).toBe('completed');
    expect(items).toEqual([]);
    expect((await store.get('runs', 'run-1') as { childResult?: string }).childResult).toBe('Found three stories');
  });
});

describe('send_message purpose', () => {
  it('delivers a result, once, and the final text after it stays a record', async () => {
    const { items, store } = await drive(runRow(routine), [turn('', send('result', 'Chip launch moved to Friday.')), turn('Sent the news')]);
    expect(items.map((item) => (item as { markdown?: string }).markdown)).toEqual(['Chip launch moved to Friday.']);
    expect((await store.get('runs', 'run-1'))?.record).toBe('Sent the news');
  });

  it.each(['answer', 'progress'])('refuses %s in a run nobody is waiting on, with nothing delivered', async (purpose) => {
    const { items, results } = await drive(runRow(routine), [turn('', send(purpose, 'working on it')), turn('Nothing to tell')]);
    expect(items).toEqual([]);
    expect(results.join('\n')).toContain('nobody asked and nobody is watching');
  });

  it.each(['answer', 'progress'])('accepts %s in a run someone waits on', async (purpose) => {
    const { items } = await drive(runRow(owner, undefined, false), [turn('', send(purpose, 'Checking now.')), turn('')]);
    expect(items.map((item) => (item as { markdown?: string }).markdown)).toEqual(['Checking now.']);
  });

  it('a person who writes into a run nobody was waiting on makes the rest of it attended: answer and progress are accepted', async () => {
    // The person's message reaches the run before its first tool batch (which it supersedes); the model then answers them.
    const first = { id: 'call_0', name: 'send_message', arguments: { kind: 'text', purpose: 'progress', text: 'Working on it.' } };
    const { items, results } = await drive(runRow(routine), [turn('', first), turn('', send('answer', 'Yes, it is ready.')), turn('')], undefined, routineWake, userWake('Also, is it ready?'));
    expect(items.map((item) => (item as { markdown?: string }).markdown)).toEqual(['Yes, it is ready.']);
    expect(results.join('\n')).not.toContain('nobody asked and nobody is watching');
  });
});

const userWake = (text: string): WakeEvent => ({ ...routineWake, id: 'wake-user', kind: 'user_message', origin: { type: 'user' }, priority: 'user', payload: { text } });

describe('a final turn that gives the person nothing (empty, or the provider declined)', () => {
  const declined: AssistantTurn = { text: '', toolCalls: [], usage, stopReason: 'refusal' };
  const texts = (items: unknown[]): unknown[] => items.map((item) => (item as { markdown?: string }).markdown);
  const waiting = (): Run => runRow(owner, undefined, false);

  it('is asked again once with a short note, and the second answer is the reply', async () => {
    const { outcome, items, store, modelCalls } = await drive(waiting(), [turn(''), turn('Chip launch moved to Friday.')], undefined, userWake('When is the launch?'));
    expect(outcome).toBe('completed');
    expect(texts(items)).toEqual(['Chip launch moved to Friday.']);
    expect(modelCalls).toBe(2);
    expect(JSON.stringify(await store.list('transcripts', { limit: 50 }))).toContain('Your last turn was empty. Answer the person now.');
  });

  it.each([
    ['empty twice', [turn(''), turn('  ')], 'no_reply'],
    ['declined twice', [declined, declined], 'refused'],
    ['declined, then empty', [declined, turn('')], 'no_reply'],
  ])('%s: the run fails with the reason code and nothing is invented', async (_name, turns, code) => {
    await expect(drive(waiting(), turns, undefined, userWake('When is the launch?'))).rejects.toMatchObject({ name: 'TerminalError', metadata: { code } });
  });

  it('a refusal that carries text is not shown to the person as a reply', async () => {
    const { items } = await drive(waiting(), [{ ...declined, text: 'I cannot help with that.' }, turn('Here is the launch date.')], undefined, userWake('When is the launch?'));
    expect(texts(items)).toEqual(['Here is the launch date.']);
  });

  it('is left alone when the run already told the person (a sent message) and when nobody is waiting', async () => {
    const answered = await drive(waiting(), [turn('', send('answer', 'On it: Friday.')), turn('')], undefined, userWake('When is the launch?'));
    expect(texts(answered.items)).toEqual(['On it: Friday.']);
    expect(answered.modelCalls).toBe(2);
    const unattended = await drive(runRow(routine), [turn('')]);
    expect(unattended.modelCalls).toBe(1);
    expect(unattended.outcome).toBe('completed');
    expect((await unattended.store.get('runs', 'run-1'))?.record).toBeUndefined();
  });
});

describe('a question card ends the turn (BACKEND §3.3 "a question card ends the turn")', () => {
  const card = { version: 1, title: 'Which time?', blocks: [{ type: 'choices', id: 'when', options: [{ id: 'am', label: '8am' }, { id: 'pm', label: '6pm' }] }] };
  const ask = { id: 'call_q', name: 'send_message', arguments: { kind: 'question', purpose: 'decision', ui: card } };
  const texts = (items: unknown[]): unknown[] => (items as Array<{ type: string; markdown?: string }>).filter((item) => item.type === 'agent_message').map((item) => item.markdown);
  const cards = (items: unknown[]): number => (items as Array<{ type: string }>).filter((item) => item.type === 'request').length;
  const waiting = (): Run => runRow(owner, undefined, false);

  it('posts the lead-in as the opening bubble, then the card; the run completes with no further model call', async () => {
    // The second turn would be a placeholder; it must never be asked for.
    const { outcome, items, store, modelCalls } = await drive(waiting(), [turn('Happy to. One thing first.', ask), turn('(Empty - question card already sent.)')], undefined, userWake('give me a daily summary'));
    expect(outcome).toBe('completed');
    expect(modelCalls).toBe(1);
    expect(texts(items)).toEqual(['Happy to. One thing first.']);
    expect(cards(items)).toBe(1);
    expect((await store.list('requests', { limit: 10 })).items).toMatchObject([{ kind: 'question', status: 'pending' }]);
  });

  it('with no lead-in text, only the card exists', async () => {
    const { outcome, items, store, modelCalls } = await drive(waiting(), [turn('', ask), turn('should not be asked')], undefined, userWake('give me a daily summary'));
    expect(outcome).toBe('completed');
    expect(modelCalls).toBe(1);
    expect(texts(items)).toEqual([]);
    expect(cards(items)).toBe(1);
    expect((await store.list('requests', { limit: 10 })).items).toHaveLength(1);
  });

  it('a plain send_message in the turn still drops the turn text as an opening line, and the run goes on to a final turn', async () => {
    const { items, modelCalls } = await drive(waiting(), [turn('Let me tell you.', send('answer', 'Friday.')), turn('')], undefined, userWake('when?'));
    expect(texts(items)).toEqual(['Friday.']);
    expect(modelCalls).toBe(2);
  });

  it('a failed question (invalid ui) does not end the turn', async () => {
    const bad = { id: 'call_q', name: 'send_message', arguments: { kind: 'question', purpose: 'decision', ui: { version: 1, blocks: [{ type: 'text', text: 'Proceed?' }] } } };
    const { modelCalls, store } = await drive(waiting(), [turn('One moment.', bad), turn('Sorry, let me ask again.')], undefined, userWake('hi'));
    expect(modelCalls).toBe(2);
    expect((await store.list('requests', { limit: 10 })).items).toEqual([]);
  });
});

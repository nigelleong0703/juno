/**
 * A scheduled routine wakes the agent with a run note built at fire time: its instructions, the run context (clock, connected
 * apps by name, web search and computer, its own recent posts, the owner's feedback) and the posting guidance. A run that posted
 * to the Feed is announced (the push trigger) when its routine finishes.
 */
import { describe, expect, it } from 'vitest';
import type { ObjectContext } from '@agent-desktop/durable';
import type { AgentEvent, Routine } from '@agent-desktop/public-contracts';
import { createMemoryStore } from '../../../../testing/store.js';
import { RecordingEnqueuer } from '../../../testing/enqueuer.js';
import { createRoutineTimerHandlers } from '../routineTimer.js';
import type { TimerState } from '../routineTimer-state.js';

const NOW = '2026-10-09T00:00:00.000Z';
const OWNER = 'owner-1';
/** The owner-scoped store stamps ownerId in production; the plain test store needs it on the row. */
const own = <T extends object>(doc: T): T => Object.assign({}, doc, { ownerId: OWNER });

function fakeCtx(state: Map<string, unknown>, received: Array<{ payload: Record<string, unknown> }>) {
  return {
    key: 'rtn-1',
    date: { now: async () => Date.parse(NOW) },
    run: async (_name: string, action: () => Promise<unknown>) => action(),
    get: async (name: string) => state.get(name),
    set: (name: string, value: unknown) => state.set(name, value),
    objectSendClient: () => ({ arm: () => undefined, fire: () => undefined, receive: (event: { payload: Record<string, unknown> }) => received.push(event) }),
    objectClient: () => ({ getState: async () => ({}) }),
  } as unknown as ObjectContext;
}

const routine = (extra: Partial<Routine> = {}): Routine & { ownerId: string } => ({
  id: 'rtn-1', agentId: 'agent-1', name: 'Daily briefing post', instructions: 'Post my morning brief',
  trigger: { kind: 'schedule', cron: '0 0 * * *', human: 'Every day at 00:00 (UTC)', tz: 'UTC' }, delivery: { channel: 'chat', target: 'conv-1' },
  notify: { mode: 'always' }, enabled: true, status: 'active', runs: [], createdAt: NOW, ownerId: OWNER, ...extra,
});

async function setup(capabilities = { webSearch: true, computer: false }) {
  const store = createMemoryStore();
  await store.put('routines', routine());
  await store.put('agents', { id: 'agent-1', name: 'Agent', pluginIds: ['plug-mail'] } as never);
  await store.put('conversations', { id: 'conv-1', kind: 'direct', agentIds: ['agent-1'], memberIds: [OWNER], unreadCount: 0, lastItemAt: NOW, createdAt: NOW });
  const events: AgentEvent[] = [];
  const emit = store.emit.bind(store);
  store.emit = async (event) => { events.push(event); return emit(event); };
  const state = new Map<string, unknown>([['state', { routineId: 'rtn-1', armed: true, armGeneration: 0, nextRunAtTime: NOW, failStreak: 0, unreadStreak: 0, firedOccurrences: [], lastFiredAt: '2026-10-08T12:00:00.000Z' } satisfies TimerState]]);
  return { store, state, events, timer: createRoutineTimerHandlers({ store, enqueuer: new RecordingEnqueuer(), capabilities }) };
}

const fire = async (setupResult: Awaited<ReturnType<typeof setup>>): Promise<string> => {
  const received: Array<{ payload: Record<string, unknown> }> = [];
  await setupResult.timer.fire(fakeCtx(setupResult.state, received), { at: NOW, routineId: 'rtn-1', generation: 0 });
  expect(received).toHaveLength(1);
  expect(received[0]?.payload).toMatchObject({ routineId: 'rtn-1' });
  return String(received[0]?.payload['text']);
};

describe('routine run note', () => {
  it('names the connected apps the agent can use, the tools it has, and says "none" when there is nothing', async () => {
    const alone = await setup();
    const empty = await fire(alone);
    expect(empty).toContain('Post my morning brief');
    expect(empty).toContain('Connected apps: none.');
    expect(empty).toContain('Web search: available. Computer and browser: not available.');
    expect(empty).toContain('Posting to the Feed (feed_post)');

    const rich = await setup({ webSearch: false, computer: true });
    await rich.store.put('connections', own({ id: 'c1', name: 'Gmail', kind: 'mcp', status: 'connected', catalogId: 'gmail', pluginId: 'plug-mail' }));
    await rich.store.put('connections', own({ id: 'c2', name: 'Google Calendar', kind: 'mcp', status: 'connected', catalogId: 'google-calendar' }));
    await rich.store.put('connections', own({ id: 'c3', name: 'Linear', kind: 'mcp', status: 'connected', catalogId: 'linear', enabled: false }));
    await rich.store.put('connections', own({ id: 'c4', name: 'Notion', kind: 'mcp', status: 'error', catalogId: 'notion' }));
    await rich.store.put('connections', own({ id: 'c5', name: 'Slack', kind: 'mcp', status: 'connected', pluginId: 'plug-other' }));
    const text = await fire(rich);
    expect(text).toContain('Connected apps: Gmail, Google Calendar.');
    expect(text).toContain('Web search: not available. Computer and browser: available.');
  });

  it('lists this routine\'s own recent posts and the owner\'s feedback on the agent\'s posts, not old or foreign ones', async () => {
    const t = await setup();
    const post = (id: string, title: string, extra: object = {}) => t.store.put('feedPosts', own({ id, agentId: 'agent-1', title, summary: 's', liked: false, createdAt: '2026-10-08T06:00:00.000Z', updatedAt: '2026-10-08T06:00:00.000Z', routineId: 'rtn-1', ...extra }));
    await post('p1', 'Chip launch', { sourceUrl: 'https://example.com/chip' });
    await post('p2', 'Gossip', { feedback: 'less', feedbackReason: 'topic' });
    await post('p3', 'Daily rates', { feedback: 'less', feedbackReason: 'frequency' });
    await post('p4', 'Old news', { feedback: 'less', feedbackReason: 'known' });
    await post('p5', 'Odd take', { feedback: 'less', feedbackReason: 'other', feedbackNote: 'too negative' });
    await post('p6', 'Great find', { feedback: 'more' });
    await post('old', 'Ancient story', { createdAt: '2026-09-01T00:00:00.000Z' });
    await post('other', 'Other routine story', { routineId: 'rtn-2' });
    const text = await fire(t);
    expect(text).toContain('- 2026-10-08: Chip launch <https://example.com/chip>');
    expect(text).toContain('Less like this (topic): Gossip');
    expect(text).toContain('Less (too often): Daily rates');
    expect(text).toContain('Less (already knew): Old news');
    expect(text).toContain('Less (other: too negative): Odd take');
    expect(text).toContain('More like this: Great find');
    expect(text).toContain('How to act on it: topic: avoid that topic; too often: post less often');
    expect(text).not.toContain('Ancient story');
    expect(text).not.toContain('Other routine story');
  });

  it('says there are no earlier posts on a first run', async () => {
    expect(await fire(await setup())).toContain('in the last 7 days: none.');
  });
});

describe('routine run completion', () => {
  it('announces the posts the run made, with the routine\'s notify setting', async () => {
    const t = await setup();
    await t.store.put('feedPosts', own({ id: 'mine', agentId: 'agent-1', title: 'Fresh', summary: 's', liked: false, createdAt: '2026-10-09T00:02:00.000Z', updatedAt: NOW, routineId: 'rtn-1' }));
    await t.store.put('feedPosts', own({ id: 'before', agentId: 'agent-1', title: 'Yesterday', summary: 's', liked: false, createdAt: '2026-10-08T00:02:00.000Z', updatedAt: NOW, routineId: 'rtn-1' }));
    await t.timer.recordCompletion(fakeCtx(t.state, []), { routineId: 'rtn-1', runId: 'run-1', occurrenceAt: NOW, succeeded: true, itemsGenerated: 0 });
    expect(t.events.filter((event) => event.type === 'feed.brief')).toEqual([{ type: 'feed.brief', routineId: 'rtn-1', title: 'Daily briefing post', postIds: ['mine'], firstPostTitle: 'Fresh', notify: true }]);
  });

  it('announces nothing when the run posted nothing', async () => {
    const t = await setup();
    await t.timer.recordCompletion(fakeCtx(t.state, []), { routineId: 'rtn-1', runId: 'run-0', occurrenceAt: NOW, succeeded: true, itemsGenerated: 0 });
    expect(t.events.some((event) => event.type === 'feed.brief')).toBe(false);
  });
});

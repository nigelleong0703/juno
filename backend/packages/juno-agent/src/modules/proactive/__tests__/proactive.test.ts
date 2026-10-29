/** Proactive preferences against the store (BACKEND §5.10): preference_note, the feedback buttons, the silence question, and where the rules are read. */
import { describe, expect, it } from 'vitest';
import type { Idea } from '@agent-desktop/public-contracts';
import type { Store, StoredRequest, WakeEvent } from '../../../contracts/index.js';
import { createMemoryStore } from '../../../testing/store.js';
import { getRow, newRow, putRow } from '../../home/mirror.js';
import { PROACTIVE_FILE } from '../../home/paths.js';
import { buildGoalWake } from '../../goals/checkin.js';
import { createPreferenceNoteTool } from '../../tools/tools/preferenceNote.js';
import { textOf, toolCtx } from '../../tools/__tests__/codingFixtures.js';
import { applyFeedback } from '../feedback.js';
import { parseRules } from '../rules.js';
import { logProactive, ownerLog, readRules } from '../service.js';
import { askIfSilent, settleSilenceQuestion, SILENCE_CHOICES_ID, SILENCE_YES } from '../silence.js';

const NOW = new Date('2026-10-23T09:00:00Z');
const OWNER = 'owner';

const rulesOf = async (store: Store) => parseRules((await getRow(store, OWNER, PROACTIVE_FILE))?.content ?? '').rules;

async function seed(): Promise<Store> {
  const store = createMemoryStore();
  await store.put('conversations', { id: 'conv-1', kind: 'direct', agentIds: ['agent-1'], memberIds: [OWNER], ownerId: OWNER, unreadCount: 0, lastItemAt: '2026-10-22T00:00:00Z', createdAt: '2026-10-01T00:00:00Z' } as never);
  await store.put('items', { id: 'itm-1', conversationId: 'conv-1', type: 'user_message', authorId: OWNER, text: 'Please stop telling me about cricket scores, I never read them.', attachments: [], mentions: [], at: '2026-10-22T10:00:00Z' } as never);
  await store.put('items', { id: 'itm-2', conversationId: 'conv-1', type: 'agent_message', agentId: 'agent-1', markdown: 'You like jazz, right?', citations: [], at: '2026-10-22T10:01:00Z' } as never);
  return store;
}

describe('preference_note', () => {
  const note = { kind: 'dont', scope: 'topic', rule: 'Cricket scores', quote: 'stop telling me about cricket scores' };
  async function run(args: unknown, wake: Partial<WakeEvent> = {}, store?: Store) {
    const s = store ?? (await seed());
    const ctx = toolCtx(s);
    const result = await createPreferenceNoteTool({ now: () => NOW }).execute(args, { ...ctx, wake: { ...ctx.wake, kind: 'user_message', trusted: true, ...wake } });
    return { result, store: s };
  }

  it('records the rule with the owner\'s words as its source when the quote is in an owner message of this chat', async () => {
    const { result, store } = await run(note);
    expect(result.isError).toBeUndefined();
    expect(await rulesOf(store)).toMatchObject([{ kind: 'dont', scope: 'topic', text: 'Cricket scores', source: 'You said "stop telling me about cricket scores"', date: '2026-10-23' }]);
  });

  it('refuses a quote that is not in an owner message here: invented, in the assistant\'s own text, or from someone else', async () => {
    const store = await seed();
    await store.put('items', { id: 'itm-3', conversationId: 'conv-1', type: 'user_message', authorId: 'someone-else', text: 'never message me about golf results', attachments: [], mentions: [], at: '2026-10-22T10:02:00Z' } as never);
    for (const quote of ['stop sending me football news', 'You like jazz, right?', 'never message me about golf results']) {
      const { result } = await run({ ...note, quote }, {}, store);
      expect(result.isError, quote).toBe(true);
      expect(textOf(result)).toContain('not in a message your owner wrote');
    }
    expect(await getRow(store, OWNER, PROACTIVE_FILE)).toBeNull();
  });

  it('refuses outside a run the owner\'s own message started: a stranger, an automatic wake, a sub-task, a shared chat', async () => {
    for (const wake of [{ trusted: false }, { kind: 'goal_checkin' as const }, { kind: 'child_task' as const }]) {
      const { result, store } = await run(note, wake);
      expect(result.isError, JSON.stringify(wake)).toBe(true);
      expect(await getRow(store, OWNER, PROACTIVE_FILE)).toBeNull();
    }
    const room = await seed();
    await room.patch('conversations', 'conv-1', { kind: 'room' } as never);
    const { result } = await run(note, {}, room);
    expect(textOf(result)).toContain('private chat');
    expect(await getRow(room, OWNER, PROACTIVE_FILE)).toBeNull();
  });
});

describe('feedback buttons', () => {
  const idea = (over: Partial<Idea & { ownerId: string }> = {}): Idea & { ownerId: string } => ({ id: 'idea-1', ownerId: OWNER, agentId: 'agent-1', text: 'Draft a note to Priya', prompt: 'p', status: 'open', topic: 'priya-move', source: 'daily', createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z', ...over });
  const deps = (store: Store) => ({ store });
  const press = (store: Store, action: 'useful' | 'not_now' | 'less' | 'never', target = { kind: 'idea' as const, id: 'idea-1' }, scope?: 'topic' | 'type') => applyFeedback(deps(store), OWNER, { target, action, ...(scope === undefined ? {} : { scope }) }, NOW);

  it('"never" on an idea writes a hard rule sourced from the button and the idea, and removes the idea from the list', async () => {
    const store = await seed();
    await store.put('ideas', idea());
    const out = await press(store, 'never');
    expect(out).toMatchObject({ rule: { kind: 'dont', strength: 'never', scope: 'topic', text: 'Priya move', source: 'You tapped Never on the idea "Draft a note to Priya"', dueForReview: false }, idea: { status: 'dismissed' } });
    expect((await rulesOf(store)).map((rule) => rule.text)).toEqual(['Priya move']);
  });

  it('"less" on a Feed post about a type of message writes a soft rule with a review date', async () => {
    const store = await seed();
    await store.put('routines', { id: 'r1', ownerId: OWNER, agentId: 'agent-1', name: 'Daily word', instructions: 'x', enabled: true } as never);
    await store.put('feedPosts', { id: 'post-1', ownerId: OWNER, agentId: 'agent-1', title: 'Serendipity', summary: 's', routineId: 'r1', liked: false, createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z' } as never);
    const out = await press(store, 'less', { kind: 'feed' as never, id: 'post-1' }, 'type');
    expect(out).toMatchObject({ rule: { kind: 'less', strength: 'less', scope: 'type', text: 'Daily word', review: '2027-01-21' } });
  });

  it('"not now" snoozes an idea (dismissed with outcome not_now) and writes no rule; "useful" makes it handled', async () => {
    const store = await seed();
    await store.put('ideas', idea());
    await store.put('ideas', idea({ id: 'idea-2', text: 'Book flights', topic: 'tokyo' }));
    expect(await press(store, 'not_now')).toMatchObject({ idea: { status: 'dismissed', outcome: 'not_now' } });
    expect(await press(store, 'useful', { kind: 'idea', id: 'idea-2' })).toMatchObject({ idea: { status: 'accepted', outcome: 'useful' } });
    expect(await getRow(store, OWNER, PROACTIVE_FILE)).toBeNull();
  });

  it('"not now" on a message snoozes its topic in the log; another account\'s item is not found', async () => {
    const store = await seed();
    await store.put('runs', { id: 'run-9', title: 'Goal: Daily check' } as never);
    await store.patch('items', 'itm-2', { runId: 'run-9' } as never);
    expect(await press(store, 'not_now', { kind: 'message' as never, id: 'itm-2' })).toEqual({});
    expect((await ownerLog(store, OWNER, ['snooze']))[0]).toMatchObject({ topic: 'you like jazz right', until: '2026-11-06T09:00:00.000Z' });
    await store.put('ideas', idea({ id: 'idea-x', ownerId: 'other' }));
    expect(await press(store, 'never', { kind: 'idea', id: 'idea-x' })).toMatchObject({ code: 'TARGET_NOT_FOUND' });
    expect(await getRow(store, OWNER, PROACTIVE_FILE)).toBeNull();
  });
});

describe('the silence question', () => {
  const unread = async (store: Store, n: number, kind: 'goal-checkin' | 'daily-check' = 'goal-checkin') => {
    for (let i = 0; i < n; i += 1) await logProactive(store, { ownerId: OWNER, kind, agentId: 'agent-1', conversationId: 'conv-1', topic: 'Learn Spanish', date: '2026-10-1' + String(i), at: '2026-10-1' + String(i) + 'T08:00:00Z' });
  };
  const questions = async (store: Store) => (await store.list('requests', { where: { kind: 'question' }, limit: 20 })).items as StoredRequest[];

  it('asks nothing after 4 unread, asks once after 5, and writes no rule until the owner says yes', async () => {
    const store = await seed();
    await unread(store, 4);
    expect(await askIfSilent({ store }, { ownerId: OWNER, agentId: 'agent-1', now: NOW })).toBeUndefined();
    await store.put('proactiveLog', { id: 'plog-5', ownerId: OWNER, kind: 'goal-checkin', conversationId: 'conv-1', date: '2026-10-19', at: '2026-10-19T08:00:00Z' });
    expect(await askIfSilent({ store }, { ownerId: OWNER, agentId: 'agent-1', now: NOW })).toBe('goal-checkin');
    const [asked] = await questions(store);
    expect(asked).toMatchObject({ title: 'Want fewer of these?', status: 'pending', silenceQuestion: { text: 'Goal check-in messages' } });
    expect(await rulesOf(store)).toEqual([]);
    // Once asked it is not asked again until five newer ones go unread.
    expect(await askIfSilent({ store }, { ownerId: OWNER, agentId: 'agent-1', now: NOW })).toBeUndefined();
    expect(await questions(store)).toHaveLength(1);

    // No (or a decline) writes nothing; yes writes one soft rule about the type.
    const answered = (choice: string): StoredRequest => ({ ...asked!, status: 'answered', payload: { ...(asked!.payload as unknown as object), answers: { [SILENCE_CHOICES_ID]: choice } } } as unknown as StoredRequest);
    await settleSilenceQuestion({ store }, OWNER, answered('no'), NOW);
    expect(await rulesOf(store)).toEqual([]);
    const yes = answered(SILENCE_YES);
    await settleSilenceQuestion({ store }, OWNER, yes, NOW);
    await settleSilenceQuestion({ store }, OWNER, yes, NOW);
    expect(await rulesOf(store)).toMatchObject([{ kind: 'less', scope: 'type', text: 'Goal check-in messages' }]);
  });

  it('counts only what the owner never read: a read chat ends the streak', async () => {
    const store = await seed();
    await unread(store, 5);
    await store.patch('conversations', 'conv-1', { lastReadAt: '2026-10-13T00:00:00Z' } as never);
    expect(await askIfSilent({ store }, { ownerId: OWNER, agentId: 'agent-1', now: NOW })).toBeUndefined();
  });

  it('raises it for ideas that expired unanswered five times in a row, and not when the daily cap is used up', async () => {
    const store = await seed();
    for (let i = 0; i < 5; i += 1) await store.put('ideas', { id: 'i' + String(i), ownerId: OWNER, agentId: 'agent-1', text: 'Idea ' + String(i), prompt: 'p', status: 'dismissed', outcome: 'ignored', source: 'daily', createdAt: '2026-10-0' + String(i + 1) + 'T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' } as never);
    for (let i = 0; i < 3; i += 1) await logProactive(store, { ownerId: OWNER, kind: 'daily-check', date: '2026-10-23', at: '2026-10-23T0' + String(i) + ':00:00Z' });
    expect(await askIfSilent({ store }, { ownerId: OWNER, agentId: 'agent-1', now: NOW })).toBeUndefined();
    const fresh = await seed();
    for (let i = 0; i < 5; i += 1) await fresh.put('ideas', { id: 'i' + String(i), ownerId: OWNER, agentId: 'agent-1', text: 'Idea ' + String(i), prompt: 'p', status: 'dismissed', outcome: 'ignored', source: 'daily', createdAt: '2026-10-0' + String(i + 1) + 'T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' } as never);
    expect(await askIfSilent({ store: fresh }, { ownerId: OWNER, agentId: 'agent-1', now: NOW })).toBe('idea');
  });
});

describe('where the rules are read', () => {
  const goal = { id: 'g1', ownerId: OWNER, agentId: 'agent-1', kind: 'goal', title: 'Learn Spanish', summary: 's', status: 'active', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' } as never;

  it('puts the rules in the text of a scheduled goal check-in, and not in a manual one the owner asked for', async () => {
    const store = await seed();
    await store.put('agents', { id: 'agent-1', ownerId: OWNER, name: 'Juno', title: 'Assistant', createdAt: '2026-10-01T00:00:00Z' } as never);
    // An old free-text file: converted on the first write, its "never" line becomes a hard rule.
    await putRow(store, newRow(OWNER, PROACTIVE_FILE, '## Never tell me about\nFootball\n', 'user', '2026-10-01T00:00:00Z'));
    await createPreferenceNoteTool({}).execute({ kind: 'less', scope: 'type', rule: 'Goal check-ins', quote: 'stop telling me about cricket scores' }, { ...toolCtx(store), wake: { ...toolCtx(store).wake, kind: 'user_message', trusted: true } });
    const scheduled = await buildGoalWake(store, goal, 'scheduled', NOW, 'k');
    const text = String(scheduled?.payload['text']);
    expect(text).toContain('NEVER message about');
    expect(text).toContain('Football');
    expect(text).toContain('Much less of');
    expect(text).toContain('Goal check-ins');
    expect(String((await buildGoalWake(store, goal, 'manual', NOW, 'k'))?.payload['text'])).not.toContain('NEVER message about');
    expect((await readRules(store, OWNER)).map((rule) => [rule.kind, rule.source])).toEqual([['dont', 'From your old preferences file'], ['less', 'You said "stop telling me about cricket scores"']]);
  });
});

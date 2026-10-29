/** Today's userState, completed runs and layered inspiration, on the production app assembly. */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import { settingsIdFor, type Today } from '@agent-desktop/public-contracts';
import { createTestApp, requestAs, withDefaultOwner } from '../../__tests__/test-app.js';

const OWNER = 'owner-a';
const NOW = new Date().toISOString();
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setup(config: Record<string, string> = {}) {
  const mem = createMemoryStore();
  const store: Store = withDefaultOwner(mem, OWNER);
  const app = createTestApp({ store, bus: mem.eventBus, enqueuer: { async enqueue() { return { accepted: true }; }, async stopRun() {}, async resolveAwakeable() {} } as never, config: config as never });
  const today = async (): Promise<Today> => (await (await requestAs(app, OWNER, '/v1/today')).json()) as Today;
  const post = (path: string) => requestAs(app, OWNER, path, { method: 'POST' });
  const agent = (id = 'agt-1', createdAt = NOW, extra: Record<string, unknown> = {}) => store.put('agents', { id, name: id, createdAt, ...extra } as never);
  const locale = (tag: string) => store.put('settings', { id: settingsIdFor(OWNER), general: { locale: tag } } as never);
  const connect = (catalogId: string, status = 'connected') => store.put('connections', { id: 'c-' + catalogId, name: catalogId, kind: 'mcp', status, catalogId, enabled: true } as never);
  const ids = (t: Today): string[] => t.inspiration.map((i) => i.id);
  return { store, app, today, post, agent, connect, locale, ids };
}

describe('userState', () => {
  it('is new without agents, starting below 10 sent messages, regular from 10', async () => {
    const { store, today, agent } = setup();
    expect((await today()).userState).toBe('new');
    await agent();
    expect((await today()).userState).toBe('starting');
    const message = (n: number) => store.put('items', { id: 'm' + String(n), conversationId: 'c', type: 'user_message', at: NOW, authorId: OWNER, text: 'hi', attachments: [], mentions: [] } as never);
    for (let n = 0; n < 9; n += 1) await message(n);
    expect((await today()).userState).toBe('starting');
    await message(9);
    expect((await today()).userState).toBe('regular');
  });
});

describe('completed', () => {
  it('lists unseen top-level runs that did work, finished in the last 24h, newest first, and drops them once seen or the chat was read', async () => {
    const { store, today, post, agent } = setup();
    await agent();
    const step = (target: string) => ({ id: 'stp-' + target, kind: 'tool', verb: 'Ran', target, status: 'completed', index: 0 });
    const run = (id: string, finishedAt: string, extra: Record<string, unknown> = {}) =>
      store.put('runs', { id, agentId: 'agt-1', title: 'T ' + id, status: 'completed', kind: 'chat', steps: [step('web_search')], startedAt: finishedAt, finishedAt, ...extra } as never);
    await run('old', ago(30 * HOUR));
    await run('a', ago(5 * HOUR));
    await run('b', ago(2 * HOUR));
    await run('child', ago(HOUR), { parentRunId: 'a' });
    await run('read', ago(3 * HOUR), { conversationId: 'conv-read' });
    // A plain reply, or one that only looked up tools or noted a memory, is a chat answer, not progress.
    await run('reply', ago(HOUR), { steps: [] });
    await run('noted', ago(HOUR), { steps: [step('tool_search'), step('memory_note')] });
    await store.put('conversations', { id: 'conv-read', kind: 'direct', title: 'x', agentIds: [], memberIds: [], unreadCount: 0, lastItemAt: NOW, createdAt: NOW, lastReadAt: ago(HOUR) } as never);
    expect((await today()).completed.map((r) => r.runId)).toEqual(['b', 'a']);
    expect((await post('/v1/runs/b/seen')).status).toBe(200);
    expect((await today()).completed.map((r) => r.runId)).toEqual(['a']);
  });
});

describe('inspiration', () => {
  it('leads a new owner to the first agent, with no agent on the action', async () => {
    const { today } = setup();
    const t = await today();
    expect(t.inspiration.length).toBeGreaterThan(0);
    for (const item of t.inspiration) expect(item.action).toEqual({ type: 'chat', text: item.prompt });
  });

  it('builds starters from what is enabled: mail connector and web search', async () => {
    const bare = setup();
    await bare.agent();
    const without = bare.ids(await bare.today());
    expect(without).not.toContain('cap-mail-digest');
    expect(without).not.toContain('cap-news-feed');
    expect(without).toContain('cap-intro');

    const rich = setup({ SEARCH_PROVIDER: 'exa' });
    await rich.agent();
    await rich.connect('gmail');
    expect(rich.ids(await rich.today())).toEqual(['cap-mail-digest', 'cap-mail-feed', 'unlock-google-calendar']);
  });

  it('adds one unlock card last while Gmail is missing, never to a new owner, and not once connected', async () => {
    const t = setup({ SEARCH_PROVIDER: 'exa' });
    expect(t.ids(await t.today()).some((id) => id.startsWith('unlock-'))).toBe(false);
    await t.agent();
    const items = (await t.today()).inspiration;
    expect(items).toHaveLength(3);
    expect(items.filter((i) => i.source === 'unlock')).toHaveLength(1);
    expect(items[2]).toMatchObject({ id: 'unlock-gmail', source: 'unlock', title: 'Connect Gmail for a morning inbox digest', prompt: 'Connect Gmail', action: { type: 'unlock', target: 'connector', connectorId: 'gmail' } });
    await t.connect('gmail');
    expect(t.ids(await t.today())).not.toContain('unlock-gmail');
    await t.post('/v1/inspiration/unlock-google-calendar/dismiss');
    expect(t.ids(await t.today())).not.toContain('unlock-google-calendar');
  });

  it('names the agent for a computer unlock', async () => {
    const t = setup();
    await t.agent('agt-1', NOW, { name: 'Haloooo' });
    await t.connect('gmail');
    await t.connect('google-calendar');
    const unlock = (await t.today()).inspiration.find((i) => i.source === 'unlock');
    expect(unlock).toMatchObject({ id: 'unlock-computer', agentId: 'agt-1', title: 'Give Haloooo a computer to compare prices and book trips', action: { type: 'unlock', target: 'computer', agentId: 'agt-1' } });
  });

  it('spreads chat starters across agents and prefers the one whose role matches', async () => {
    const spread = setup({ SEARCH_PROVIDER: 'exa' });
    await spread.agent('a1', ago(2 * DAY));
    await spread.agent('a2', ago(DAY));
    await spread.connect('gmail');
    const first = (await spread.today()).inspiration.filter((i) => i.source !== 'unlock').map((i) => i.agentId);
    expect(first).toEqual(['a1', 'a2']);
    expect((await spread.today()).inspiration.filter((i) => i.source !== 'unlock').map((i) => i.agentId)).toEqual(first);

    const roles = setup({ SEARCH_PROVIDER: 'exa' });
    await roles.agent('a1', ago(2 * DAY), { title: 'Calendar helper' });
    await roles.agent('a2', ago(DAY), { title: 'Inbox and email' });
    await roles.connect('gmail');
    const mail = (await roles.today()).inspiration.find((i) => i.id === 'cap-mail-digest');
    expect(mail?.agentId).toBe('a2');
  });

  it('answers in Chinese for a zh locale, ideas keep their own language', async () => {
    const t = setup();
    await t.agent();
    await t.locale('zh-Hans-SG');
    await t.store.put('ideas', { id: 'idea-1', agentId: 'agt-1', text: 'Reply to Priya', prompt: 'p', status: 'open', createdAt: NOW, updatedAt: NOW } as never);
    const items = (await t.today()).inspiration;
    expect(items.map((i) => i.id)).toEqual(['idea-1', 'cap-brief-feed', 'unlock-gmail']);
    expect(items[0]?.title).toBe('Reply to Priya');
    expect(items[1]).toMatchObject({ title: '每天早上先看一份简报' });
    expect(items[2]).toMatchObject({ title: '连接 Gmail，每天早上收邮件摘要', prompt: '连接 Gmail' });
  });

  it('asks the agent to set up a routine that posts to the Feed, and stops offering a kind once the owner has such a routine', async () => {
    const t = setup({ SEARCH_PROVIDER: 'exa' });
    await t.agent();
    const first = (await t.today()).inspiration.find((i) => i.id === 'cap-brief-feed' || i.id === 'cap-news-feed');
    expect(first?.action).toMatchObject({ type: 'chat', agentId: 'agt-1', text: expect.stringMatching(/^Every morning at \d?\d:\d\d, .*post .* to my Feed\.$/) });
    const routine = (id: string, name: string, instructions: string, enabled = true) => t.store.put('routines', { id, agentId: 'agt-1', name, instructions, trigger: { kind: 'schedule', cron: '0 7 * * *', human: 'daily', tz: 'UTC' }, delivery: { channel: 'chat' }, notify: { mode: 'always' }, enabled, status: 'active', runs: [], createdAt: NOW } as never);
    await routine('r-off', 'Tech news', 'post the top news', false);
    expect(t.ids(await t.today())).toContain('cap-news-feed');
    await routine('r1', 'Daily AI news', 'post the top AI news to my Feed');
    expect(t.ids(await t.today())).not.toContain('cap-news-feed');
  });

  it('puts fresh ideas first, then profile starters, and fills the profile city in', async () => {
    const t = setup({ SEARCH_PROVIDER: 'exa' });
    await t.agent();
    await t.store.put('profiles', { id: 'profile-' + OWNER, entries: [{ id: 'e1', key: 'Home address', value: 'x\nSingapore 000001\nSingapore', visibility: 'private', source: { by: 'user', at: NOW } }], updatedAt: NOW } as never);
    await t.store.put('ideas', { id: 'idea-1', agentId: 'agt-1', text: 'Reply to Priya', prompt: 'Draft a reply to Priya', why: 'She wrote yesterday', status: 'open', createdAt: NOW, updatedAt: NOW } as never);
    await t.store.put('ideas', { id: 'idea-2', agentId: 'agt-1', text: 'Done one', prompt: 'p', status: 'accepted', createdAt: NOW, updatedAt: NOW } as never);
    const items = (await t.today()).inspiration;
    expect(items[0]).toMatchObject({ id: 'idea-1', source: 'idea', agentId: 'agt-1', reason: 'She wrote yesterday', action: { type: 'chat', agentId: 'agt-1', text: 'Draft a reply to Priya' } });
    expect(items.map((i) => i.source)).toEqual(['idea', 'profile', 'unlock']);
    expect(items.some((i) => i.title.includes('Singapore'))).toBe(true);
    expect(items.some((i) => i.title.includes('{'))).toBe(false);
  });

  it('never returns a dismissed item (idea or starter) and stops after 3 days', async () => {
    const t = setup();
    await t.agent();
    await t.store.put('ideas', { id: 'idea-1', agentId: 'agt-1', text: 'Reply', prompt: 'p', status: 'open', createdAt: NOW, updatedAt: NOW } as never);
    expect(t.ids(await t.today())).toContain('idea-1');
    expect((await t.post('/v1/inspiration/idea-1/dismiss')).status).toBe(200);
    expect(await t.store.get('ideas', 'idea-1')).toMatchObject({ status: 'dismissed' });
    expect(t.ids(await t.today())).not.toContain('idea-1');

    expect(t.ids(await t.today())).toContain('cap-intro');
    await t.store.patch('inspirations', `${OWNER}:cap-intro`, { firstShownAt: ago(4 * DAY) });
    expect(t.ids(await t.today())).not.toContain('cap-intro');
    await t.store.put('inspirations', { id: `${OWNER}:cap-brief-feed`, inspirationId: 'cap-brief-feed', firstShownAt: ago(2 * DAY), updatedAt: NOW, ownerId: OWNER } as never);
    expect(t.ids(await t.today())).toContain('cap-brief-feed');
    await t.post('/v1/inspiration/cap-brief-feed/dismiss');
    expect(t.ids(await t.today())).not.toContain('cap-brief-feed');
  });
});

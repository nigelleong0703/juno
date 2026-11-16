/** The daily ideas job on the in-memory store with a scripted model: what it keeps, what the gate and the cooldown drop, when it skips. */
import { describe, expect, it } from 'vitest';
import type { Store, Tool } from '../../../contracts/index.js';
import { runWithOwner, requestScopedStore } from '../../../owner-context.js';
import { createMemoryStore } from '../../../testing/store.js';
import { homeHash } from '../../home/paths.js';
import { getRow, newRow, putRow } from '../../home/mirror.js';
import type { JobModel } from '../../memory/jobs/types.js';
import { listAll } from '../../memory/util.js';
import { BUILTIN_CATALOG_ENTRIES, createConnectorCatalog } from '../../mcp/catalog.js';
import type { ObjectContext } from '@agent-desktop/durable';
import { createIdeasTimerService } from '../../../execution/harness/services/ideas-timer.js';
import type { Brain, WakeEvent } from '../../../contracts/index.js';
import { runDailyIdeas, type IdeasDeps } from '../job.js';

const OWNER = 'owner-1';
const AGENT = 'agt-1';
const NOW = new Date('2026-10-15T08:10:00Z');
const usage = { inputTokens: 100, outputTokens: 20, costUsd: 0.001, costKnown: true };

function scriptedModel(...answers: string[]): JobModel & { prompts: string[] } {
  const prompts: string[] = [];
  return { prompts, async complete(input) { prompts.push(input.prompt); const text = answers.shift(); return text === undefined ? null : { text, usage, model: 'test-model' }; } };
}

const idea = (over: Record<string, unknown> = {}) => ({ topic: 'priya-move', title: 'Draft a note to Priya about the move', why: 'You told Juno the Friday meeting moved to Monday.', agentId: AGENT, prompt: 'Review the draft and send it to Priya.', requires: ['web_fetch'], ...over });

async function setup(model: JobModel) {
  const store: Store = requestScopedStore(createMemoryStore());
  const files = new Map<string, string>([['.juno-sync', 'x']]);
  const home = {
    async snapshot() { return { synced: true, files: [...files].map(([path, content]) => ({ path, hash: homeHash(content), mtime: 1 })) }; },
    async read(_a: string, path: string) { const content = files.get(path); return content === undefined ? null : { content, hash: homeHash(content) }; },
    async write(_a: string, path: string, content: string) { files.set(path, content); return { hash: homeHash(content) }; },
    async delete(_a: string, path: string) { files.delete(path); },
    async ensure(_a: string, path: string) { if (!files.has(path)) files.set(path, ''); },
    async putFile() { return { hash: 'h', written: true }; },
    async extractText() { return { text: '', truncated: false }; },
  };
  const tools = { async forAgent(): Promise<Tool[]> { return [{ name: 'web_fetch' }, { name: 'suggest' }] as Tool[]; } };
  const deps: IdeasDeps = { store, home, model, tools, catalog: createConnectorCatalog(BUILTIN_CATALOG_ENTRIES), now: () => NOW };
  await runWithOwner(OWNER, async () => {
    await store.put('agents', { id: AGENT, name: 'Juno', title: 'Assistant', ownerId: OWNER, createdAt: '2026-01-01T00:00:00Z' } as never);
    await store.put('conversations', { id: 'c1', kind: 'direct', agentIds: [AGENT], memberIds: [OWNER], ownerId: OWNER, unreadCount: 0, lastItemAt: '2026-10-14T08:00:00Z', createdAt: '2026-10-01T00:00:00Z' } as never);
    await store.put('items', { id: 'itm-1', conversationId: 'c1', at: '2026-10-14T08:00:00Z', type: 'user_message', authorId: OWNER, text: 'The Friday meeting moved to Monday, tell Priya.', attachments: [], mentions: [] });
  });
  return { store, files, deps, inOwner: <T>(fn: () => Promise<T>): Promise<T> => runWithOwner(OWNER, fn) };
}

describe('daily ideas job', () => {
  it('saves ideas the agent can do, with a draft, and drops what its tools cannot do', async () => {
    const model = scriptedModel(JSON.stringify({ ideas: [
      idea({ prepared: { title: 'Note to Priya', content: 'Hi Priya, the meeting moved to Monday.' } }),
      idea({ topic: 'haggle', title: 'Haggle on the bike listing', requires: ['marketplace_haggle'] }),
      idea({ topic: 'nobody', title: 'Ask a stranger', agentId: 'agt-missing' }),
      { title: 'no fields' },
    ] }));
    const { store, files, deps, inOwner } = await setup(model);
    const result = await inOwner(() => runDailyIdeas(deps, { ownerId: OWNER, checkpoint: {} }));
    expect(result.outcome).toBe('done');
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0]).toMatchObject({ text: 'Draft a note to Priya about the move', source: 'daily', status: 'open', agentId: AGENT, prepared: { kind: 'draft', ref: 'drafts/2026-10-15-note-to-priya.md' } });
    expect(result.saved[0]?.action?.prompt).toContain('/juno/drafts/2026-10-15-note-to-priya.md');
    expect(result.dropped).toEqual(['Haggle on the bike listing: the agent has no tool marketplace_haggle', 'Ask a stranger: no such agent that may reach out', 'malformed idea']);
    expect(files.get('drafts/2026-10-15-note-to-priya.md')).toContain('the meeting moved to Monday');
    expect((await inOwner(() => getRow(store, OWNER, 'drafts/2026-10-15-note-to-priya.md')))?.writer).toBe('platform');
    const runs = await inOwner(() => listAll(store, 'runs'));
    expect(runs.map((run) => run.triggerLabel)).toEqual(['Ideas: daily']);
  });

  it('keeps an idea whose only missing piece is an unconnected app, naming it, and still drops a missing built-in tool', async () => {
    const model = scriptedModel(JSON.stringify({ ideas: [
      idea({ topic: 'notion-plan', title: 'Move the move checklist into Notion', requires: ['notion'] }),
      idea({ topic: 'notion-haggle', title: 'Haggle using Notion notes', requires: ['notion', 'marketplace_haggle'] }),
    ] }));
    const { deps, inOwner } = await setup(model);
    const result = await inOwner(() => runDailyIdeas(deps, { ownerId: OWNER, checkpoint: {} }));
    expect(model.prompts[0]).toContain('- notion: Notion, ');
    expect(result.saved.map((row) => row.text)).toEqual(['Move the move checklist into Notion']);
    expect(result.saved[0]?.why).toBe('You told Juno the Friday meeting moved to Monday. Needs Notion connected.');
    expect(result.dropped).toEqual(['Haggle using Notion notes: the agent has no tool marketplace_haggle']);
  });

  it('offers only the apps in the injected catalog: with the built-ins switched off an idea needing Notion is dropped', async () => {
    const model = scriptedModel(JSON.stringify({ ideas: [idea({ topic: 'notion-plan', title: 'Move the move checklist into Notion', requires: ['notion'] })] }));
    const { deps, inOwner } = await setup(model);
    const result = await inOwner(() => runDailyIdeas({ ...deps, catalog: createConnectorCatalog([]) }, { ownerId: OWNER, checkpoint: {} }));
    expect(model.prompts[0]).not.toContain('- notion: Notion');
    expect(result.saved).toEqual([]);
    expect(result.dropped).toHaveLength(1);
  });

  it('skips a second run the same day and an unchanged day, and never offers a recently dismissed idea', async () => {
    const model = scriptedModel(JSON.stringify({ ideas: [idea()] }), JSON.stringify({ ideas: [idea({ title: 'Message Priya about Monday' }), idea({ topic: 'groceries', title: 'Plan the week\'s groceries', requires: [] })] }));
    const { store, deps, inOwner } = await setup(model);
    const first = await inOwner(() => runDailyIdeas(deps, { ownerId: OWNER, checkpoint: {} }));
    expect(first.saved).toHaveLength(1);
    expect((await inOwner(() => runDailyIdeas(deps, { ownerId: OWNER, checkpoint: first.checkpoint }))).outcome).toBe('skipped');

    const tomorrow = { ...deps, now: () => new Date('2026-10-16T08:10:00Z') };
    expect((await inOwner(() => runDailyIdeas(tomorrow, { ownerId: OWNER, checkpoint: first.checkpoint }))).outcome).toBe('skipped');

    const saved = first.saved[0];
    await inOwner(() => store.patch('ideas', saved?.id ?? '', { status: 'dismissed', updatedAt: '2026-10-16T07:00:00Z' }));
    const forced = await inOwner(() => runDailyIdeas(tomorrow, { ownerId: OWNER, checkpoint: first.checkpoint, force: true }));
    expect(forced.saved.map((row) => row.text)).toEqual(["Plan the week's groceries"]);
    expect(forced.dropped).toEqual(['Message Priya about Monday: repeats an earlier idea (dismissed)']);
    expect(model.prompts[1]).toContain('Offered before (waiting, handled, dismissed, snoozed or ignored: do not offer again)');
    expect(model.prompts[1]).toContain('- Draft a note to Priya about the move [priya-move] (dismissed)');
  });

  it('never re-offers an accepted idea, even reworded; a dismissed one comes back only after 60 days', async () => {
    const reworded = (over: Record<string, unknown> = {}) => idea({ title: 'Write Priya a note about Monday', topic: 'Priya move', verb: 'draft', ...over });
    const model = scriptedModel(JSON.stringify({ ideas: [reworded()] }), JSON.stringify({ ideas: [reworded()] }), JSON.stringify({ ideas: [reworded()] }));
    const { store, deps, inOwner } = await setup(model);
    const earlier = (status: string, updatedAt: string) => inOwner(() => store.put('ideas', { id: 'idea-old', ownerId: OWNER, agentId: AGENT, text: 'Draft a note to Priya about the move', prompt: 'p', status, topic: 'priya-move', key: 'priya move|draft', source: 'daily', createdAt: updatedAt, updatedAt } as never));
    await earlier('accepted', '2026-08-01T00:00:00Z');
    const accepted = await inOwner(() => runDailyIdeas(deps, { ownerId: OWNER, checkpoint: {}, force: true }));
    expect(accepted.saved).toEqual([]);
    expect(accepted.dropped).toEqual(['Write Priya a note about Monday: repeats an earlier idea (already handled)']);
    await earlier('dismissed', '2026-08-20T00:00:00Z');
    expect((await inOwner(() => runDailyIdeas(deps, { ownerId: OWNER, checkpoint: {}, force: true }))).dropped).toEqual(['Write Priya a note about Monday: repeats an earlier idea (dismissed)']);
    await earlier('dismissed', '2026-08-10T00:00:00Z');
    const later = await inOwner(() => runDailyIdeas(deps, { ownerId: OWNER, checkpoint: {}, force: true }));
    expect(later.saved.map((row) => row.key)).toEqual(['priya move|draft']);
  });

  it('turns an idea that stayed open for 14 days into "ignored" and offers it again once', async () => {
    const model = scriptedModel(JSON.stringify({ ideas: [idea({ verb: 'draft' })] }), JSON.stringify({ ideas: [idea({ verb: 'draft' })] }));
    const { store, deps, inOwner } = await setup(model);
    await inOwner(() => store.put('ideas', { id: 'idea-old', ownerId: OWNER, agentId: AGENT, text: 'Draft a note to Priya about the move', prompt: 'p', status: 'open', topic: 'priya-move', key: 'priya move|draft', source: 'daily', createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z' } as never));
    // It leaves the list as ignored, and is not offered again for 14 days; after that it may come back once.
    const first = await inOwner(() => runDailyIdeas(deps, { ownerId: OWNER, checkpoint: {} }));
    expect(await inOwner(() => store.get('ideas', 'idea-old'))).toMatchObject({ status: 'dismissed', outcome: 'ignored' });
    expect(first.dropped).toEqual(['Draft a note to Priya about the move: repeats an earlier idea (shown and ignored)']);
    await inOwner(() => store.patch('ideas', 'idea-old', { updatedAt: '2026-09-30T00:00:00Z' }));
    const later = await inOwner(() => runDailyIdeas(deps, { ownerId: OWNER, checkpoint: {}, force: true }));
    expect(later.saved.map((row) => row.key)).toEqual(['priya move|draft']);
  });

  it('tells the model what the owner already has going: routines, monitors, calendar items, running tasks and this week\'s chat topics', async () => {
    const model = scriptedModel(JSON.stringify({ ideas: [] }));
    const { store, deps, inOwner } = await setup(model);
    await inOwner(async () => {
      await store.put('routines', { id: 'r1', ownerId: OWNER, agentId: AGENT, name: 'Morning news', instructions: 'Post the top three headlines', enabled: true } as never);
      await store.put('routines', { id: 'r2', ownerId: OWNER, agentId: AGENT, name: 'Flight price', instructions: 'Watch the Tokyo fare', enabled: true, monitor: {} } as never);
      await store.put('agentCalendar', { id: 'cal1', ownerId: OWNER, agentId: AGENT, kind: 'task', title: 'Call the dentist', at: '2026-10-17T09:00:00Z', status: 'scheduled' } as never);
      await store.put('agentTasks', { id: 't1', agentId: AGENT, kind: 'subagent', title: 'Find rain jackets', status: 'running', startedAt: '2026-10-15T07:00:00Z', updatedAt: '2026-10-15T07:30:00Z' } as never);
    });
    await inOwner(() => runDailyIdeas(deps, { ownerId: OWNER, checkpoint: {} }));
    const prompt = model.prompts[0] ?? '';
    for (const line of ['- routine "Morning news": Post the top three headlines', '- monitor "Flight price": Watch the Tokyo fare', '2026-10-17 Call the dentist', '- Find rain jackets', '- The Friday meeting moved to Monday, tell Priya.']) expect(prompt).toContain(line);
  });

  it('drops in code what a never rule covers, and gives soft rules and the hard ones to the model; a one-time free-text file is converted', async () => {
    const model = scriptedModel(JSON.stringify({ ideas: [idea({ topic: 'cricket', title: 'Follow the cricket scores tonight', why: 'You asked about cricket scores once.' }), idea({ topic: 'groceries', title: 'Plan the groceries', requires: [] })] }));
    const { store, files, deps, inOwner } = await setup(model);
    await inOwner(async () => {
      await putRow(store, newRow(OWNER, 'PROACTIVE_PREFERENCES.md', '# Proactive preferences\n## Never tell me about\nCricket scores\n', 'user', '2026-10-01T00:00:00Z'));
    });
    const result = await inOwner(() => runDailyIdeas(deps, { ownerId: OWNER, checkpoint: {} }));
    expect(result.saved.map((row) => row.text)).toEqual(['Plan the groceries']);
    expect(result.dropped).toEqual(['Follow the cricket scores tonight: the owner said never to hear about "Cricket scores"']);
    expect(model.prompts[0]).toContain('NEVER message about (hard rules, no exceptions):\n- Cricket scores (topic)');
    expect(files.get('PROACTIVE_PREFERENCES.md')).toContain("## Don't tell me\n- Cricket scores | id: ");
    expect(files.get('PROACTIVE_PREFERENCES.md')).toContain('source: "From your old preferences file"');
  });

  it('puts the rules in the wake text of the daily notice, drops a notice a never rule covers, and drops it when the daily cap is used up', async () => {
    const reply = (text: string) => JSON.stringify({ ideas: [], notice: { text, conversationId: 'c1' } });
    const model = scriptedModel(reply('Check the air quality in Singapore today and tell the user if it is unhealthy.'), reply('Check the cricket scores today.'), reply('Check the air quality in Singapore today.'));
    const { store, deps, inOwner } = await setup(model);
    await inOwner(async () => {
      await putRow(store, newRow(OWNER, 'PROACTIVE_PREFERENCES.md', '## Never tell me about\nCricket scores\n', 'user', '2026-10-01T00:00:00Z'));
    });
    const first = await inOwner(() => runDailyIdeas(deps, { ownerId: OWNER, checkpoint: {}, force: true }));
    const text = String(first.wakes[0]?.payload['text']);
    expect(text).toContain('Check the air quality in Singapore');
    expect(text).toContain('NEVER message about (hard rules, no exceptions):\n- Cricket scores (topic)');
    expect(text).not.toContain('/juno/PROACTIVE_PREFERENCES.md');
    expect((await inOwner(() => runDailyIdeas(deps, { ownerId: OWNER, checkpoint: {}, force: true }))).wakes).toEqual([]);
    await inOwner(async () => {
      for (let n = 0; n < 3; n += 1) await store.put('proactiveLog', { id: 'plog-' + String(n), ownerId: OWNER, kind: 'goal-checkin', date: '2026-10-15', at: '2026-10-15T0' + String(n) + ':00:00Z' });
    });
    expect((await inOwner(() => runDailyIdeas(deps, { ownerId: OWNER, checkpoint: {}, force: true }))).wakes).toEqual([]);
  });

  describe('who a proactive message comes from', () => {
    /** The incident: the owner's oldest agent ("Test") is bound to a Feishu chat and nothing is the default; "Personal Life" has the app chat about the concert. */
    async function twoAgents(model: JobModel) {
      const s = await setup(model);
      await s.inOwner(async () => {
        await s.store.put('agents', { id: 'agt-test', name: 'Test', title: 'Tester', ownerId: OWNER, createdAt: '2025-12-01T00:00:00Z' } as never);
        await s.store.put('agents', { id: 'agt-life', name: 'Personal Life', title: 'Life', ownerId: OWNER, createdAt: '2026-02-01T00:00:00Z' } as never);
        await s.store.put('conversations', { id: 'c-feishu', kind: 'direct', agentIds: ['agt-test'], memberIds: [OWNER], ownerId: OWNER, channel: { kind: 'feishu', channelId: 'ch-1' }, unreadCount: 0, lastItemAt: '2026-10-10T00:00:00Z', createdAt: '2026-10-01T00:00:00Z' } as never);
        await s.store.put('conversations', { id: 'c-life', kind: 'direct', agentIds: ['agt-life'], memberIds: [OWNER], ownerId: OWNER, unreadCount: 0, lastItemAt: '2026-10-14T09:00:00Z', createdAt: '2026-10-02T00:00:00Z' } as never);
        await s.store.put('items', { id: 'itm-life', conversationId: 'c-life', at: '2026-10-14T09:00:00Z', type: 'user_message', authorId: OWNER, text: 'help me buy the LANY concert ticket', attachments: [], mentions: [] });
      });
      return s;
    }
    const withNotice = (conversationId: string, ideas: unknown[] = []) => JSON.stringify({ ideas, notice: { text: 'Check whether the LANY concert is still on tomorrow.', conversationId } });
    const run = (s: Awaited<ReturnType<typeof setup>>) => s.inOwner(() => runDailyIdeas(s.deps, { ownerId: OWNER, checkpoint: {}, force: true }));

    it('sends the notice from the agent whose app chat it came from, in that chat, not from the oldest agent in its Feishu chat', async () => {
      const model = scriptedModel(withNotice('c-life'));
      const s = await twoAgents(model);
      const result = await run(s);
      expect(result.wakes[0]).toMatchObject({ agentId: 'agt-life', conversationId: 'c-life' });
      expect(model.prompts[0]).toContain('(conversation c-life, with Personal Life): help me buy the LANY concert ticket');
      expect(result.wakes[0]?.agentId).not.toBe('agt-test');
    });

    it('drops a notice whose source conversation was not in the material, or that has none', async () => {
      const model = scriptedModel(withNotice('c-feishu'), JSON.stringify({ ideas: [], notice: { text: 'Check the weather.' } }));
      const s = await twoAgents(model);
      expect((await run(s)).wakes).toEqual([]);
      expect((await run(s)).wakes).toEqual([]);
    });

    it('rejects an idea that hands one agent\'s conversation topic to another agent, and one citing a conversation it was not shown', async () => {
      const model = scriptedModel(JSON.stringify({ ideas: [
        idea({ topic: 'lany', title: 'Buy the LANY ticket', agentId: 'agt-test', conversationId: 'c-life', requires: [] }),
        idea({ topic: 'lany2', title: 'Check the LANY venue', agentId: 'agt-life', conversationId: 'c-feishu', requires: [] }),
        idea({ topic: 'lany3', title: 'Plan the LANY evening', agentId: 'agt-life', conversationId: 'c-life', requires: [] }),
      ] }));
      const s = await twoAgents(model);
      const result = await run(s);
      expect(result.saved.map((row) => row.text)).toEqual(['Plan the LANY evening']);
      expect(result.dropped).toEqual([
        'Buy the LANY ticket: its source conversation belongs to Personal Life, not to the agent it names',
        'Check the LANY venue: its source conversation is not one of those shown',
      ]);
    });
  });

  it('runs nothing and sends no notice when the owner switched the daily check off, and again when it is on', async () => {
    const model = scriptedModel(JSON.stringify({ ideas: [idea()], notice: { text: 'Check the air quality.', conversationId: 'c1' } }));
    const { store, deps, inOwner } = await setup(model);
    await inOwner(() => store.put('settings', { id: 'app-settings-' + OWNER, ownerId: OWNER, general: { dailyCheck: { enabled: false, time: '21:30' } } } as never));
    const off = await inOwner(() => runDailyIdeas(deps, { ownerId: OWNER, checkpoint: {}, force: true }));
    expect(off).toMatchObject({ outcome: 'skipped', saved: [] });
    expect(off.wakes).toEqual([]);
    expect(model.prompts).toHaveLength(0);
    await inOwner(() => store.put('settings', { id: 'app-settings-' + OWNER, ownerId: OWNER, general: { dailyCheck: { enabled: true, time: '21:30' } } } as never));
    const on = await inOwner(() => runDailyIdeas(deps, { ownerId: OWNER, checkpoint: {}, force: true }));
    expect(on.saved).toHaveLength(1);
    expect(on.wakes).toHaveLength(1);
  });

  describe('when a planned notice is sent', () => {
    const planned = (extra: Record<string, unknown>) => JSON.stringify({ ideas: [], notices: [{ text: 'Check whether the LANY concert is still on and whether tickets are left.', conversationId: 'c1', whenWhy: 'The concert starts 20:00; remind at 12:00 to check tickets.', ...extra }] });
    const settings = (store: Store, general: Record<string, unknown>) => store.put('settings', { id: 'app-settings-' + OWNER, ownerId: OWNER, general } as never);
    const planOne = async (extra: Record<string, unknown>, general?: Record<string, unknown>) => {
      const s = await setup(scriptedModel(planned(extra)));
      if (general !== undefined) await s.inOwner(() => settings(s.store, general));
      const result = await s.inOwner(() => runDailyIdeas(s.deps, { ownerId: OWNER, checkpoint: {}, force: true }));
      return { ...s, result, at: result.wakes.map((wake) => wake.at) };
    };

    it('sends at the time the model chose, from the source conversation\'s agent, saying why then', async () => {
      const { result } = await planOne({ sendAt: '2026-10-15T12:00:00+00:00' });
      expect(result.wakes).toHaveLength(1);
      expect(result.wakes[0]).toMatchObject({ at: '2026-10-15T12:00:00.000Z', agentId: AGENT, conversationId: 'c1' });
      const text = String(result.wakes[0]?.payload['text']);
      expect(text).toContain('It is 2026-10-15 12:00 on the user');
      expect(text).toContain('Why now: The concert starts 20:00; remind at 12:00 to check tickets.');
    });

    it('reads HH:MM as the owner\'s local time, today or else tomorrow', async () => {
      const sgt = { timezone: 'Asia/Singapore' };
      expect((await planOne({ sendAt: '20:00' }, sgt)).at).toEqual(['2026-10-15T12:00:00.000Z']);
      // 09:00 in Singapore is already past at 16:10 there: tomorrow.
      expect((await planOne({ sendAt: '09:00' }, sgt)).at).toEqual(['2026-10-16T01:00:00.000Z']);
    });

    it('holds a time inside the quiet hours until they end, by default 23:00 to 07:30 and as the owner sets them', async () => {
      expect((await planOne({ sendAt: '2026-10-15T23:30:00+00:00' })).at).toEqual(['2026-10-16T07:30:00.000Z']);
      expect((await planOne({ sendAt: '2026-10-16T03:00:00+00:00' })).at).toEqual(['2026-10-16T07:30:00.000Z']);
      expect((await planOne({ sendAt: '2026-10-15T13:00:00+00:00' }, { dailyCheck: { quiet: { from: '12:00', to: '14:00' } } })).at).toEqual(['2026-10-15T14:00:00.000Z']);
      expect((await planOne({ sendAt: '2026-10-15T23:30:00+00:00' }, { dailyCheck: { quiet: { from: '00:00', to: '00:00' } } })).at).toEqual(['2026-10-15T23:30:00.000Z']);
    });

    it('moves a time in the past to now, one beyond 36 hours to the limit, and no time to now', async () => {
      expect((await planOne({ sendAt: '2026-10-15T06:00:00+00:00' })).at).toEqual([NOW.toISOString()]);
      expect((await planOne({ sendAt: '2026-10-20T12:00:00+00:00' })).at).toEqual(['2026-10-16T20:10:00.000Z']);
      expect((await planOne({ sendAt: 'sometime soon' })).at).toEqual([NOW.toISOString()]);
      expect((await planOne({})).at).toEqual([NOW.toISOString()]);
    });

    it('plans several notices, never more than the daily cap leaves room for', async () => {
      const notice = (n: number) => ({ text: 'Check item ' + String(n), conversationId: 'c1', sendAt: '2026-10-15T1' + String(n) + ':00:00+00:00' });
      const s = await setup(scriptedModel(JSON.stringify({ ideas: [], notices: [notice(1), notice(2), notice(3), notice(4)] })));
      await s.inOwner(() => s.store.put('proactiveLog', { id: 'plog-0', ownerId: OWNER, kind: 'goal-checkin', date: '2026-10-15', at: '2026-10-15T00:00:00Z' }));
      const result = await s.inOwner(() => runDailyIdeas(s.deps, { ownerId: OWNER, checkpoint: {}, force: true }));
      expect(result.wakes.map((wake) => wake.at)).toEqual(['2026-10-15T11:00:00.000Z', '2026-10-15T12:00:00.000Z']);
      expect(new Set(result.wakes.map((wake) => wake.id)).size).toBe(2);
    });

    /** The daily timer with its durable context faked at the edge only: what it schedules and what it hands to the session. */
    async function timer(model: JobModel, general?: Record<string, unknown>) {
      const s = await setup(model);
      if (general !== undefined) await s.inOwner(() => settings(s.store, general));
      const service = createIdeasTimerService({ store: s.store, brain: { completeText: model.complete.bind(model) } as unknown as Brain, tools: s.deps.tools, catalog: s.deps.catalog });
      const state = new Map<string, unknown>();
      const sent: Array<{ object: string; key: string; handler: string; params: unknown; delay?: number; idempotencyKey?: string }> = [];
      const ctx = {
        key: OWNER,
        date: { now: async () => NOW.getTime() },
        run: async (_name: string, action: () => Promise<unknown>) => action(),
        get: async (name: string) => state.get(name),
        set: (name: string, value: unknown) => state.set(name, value),
        objectSendClient: (def: { name: string }, key: string) => new Proxy({}, { get: (_t, handler: string) => (params: unknown, opts?: { delay?: number; idempotencyKey?: string }) => { sent.push({ object: def.name, key, handler, params, ...(opts?.delay === undefined ? {} : { delay: opts.delay }), ...(opts?.idempotencyKey === undefined ? {} : { idempotencyKey: opts.idempotencyKey }) }); } }),
      } as unknown as ObjectContext;
      const handlers = service.handlers as unknown as { runNow: (c: ObjectContext, p: { force: boolean }) => Promise<unknown>; deliver: (c: ObjectContext, p: { wake: WakeEvent }) => Promise<void> };
      return { ...s, sent, state, ctx, handlers };
    }

    it('schedules a durable delayed delivery at the planned time, and a retried run does not schedule it twice', async () => {
      const model = scriptedModel(planned({ sendAt: '2026-10-15T12:00:00+00:00' }), planned({ sendAt: '2026-10-15T12:00:00+00:00' }));
      const t = await timer(model);
      await t.handlers.runNow(t.ctx, { force: true });
      t.state.clear(); // a retry from a fresh checkpoint reads the same conversation and plans the same notice
      await t.handlers.runNow(t.ctx, { force: true });
      const deliveries = t.sent.filter((call) => call.handler === 'deliver');
      expect(deliveries).toHaveLength(2);
      expect(deliveries[0]).toMatchObject({ object: 'IdeasTimer', key: OWNER, delay: Date.parse('2026-10-15T12:00:00Z') - NOW.getTime() });
      // The same notice has the same key both times: the durable layer drops the second send.
      expect(deliveries[0]?.idempotencyKey).toBeDefined();
      expect(deliveries[1]?.idempotencyKey).toBe(deliveries[0]?.idempotencyKey);
      expect(t.sent.some((call) => call.object === 'Session')).toBe(false);
    });

    it('hands the notice to the source agent\'s session when it is due, and nothing if the owner switched the daily check off meanwhile', async () => {
      const model = scriptedModel(planned({ sendAt: '2026-10-15T12:00:00+00:00' }));
      const t = await timer(model);
      await t.handlers.runNow(t.ctx, { force: true });
      const wake = (t.sent.find((call) => call.handler === 'deliver')?.params as { wake: WakeEvent }).wake;
      await t.inOwner(() => t.handlers.deliver(t.ctx, { wake }));
      expect(t.sent.filter((call) => call.object === 'Session')).toMatchObject([{ key: 'agt-1:c1', handler: 'receive', params: wake }]);
      await t.inOwner(() => settings(t.store, { dailyCheck: { enabled: false } }));
      await t.inOwner(() => t.handlers.deliver(t.ctx, { wake }));
      expect(t.sent.filter((call) => call.object === 'Session')).toHaveLength(1);
    });
  });
});

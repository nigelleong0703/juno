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
    const reply = (text: string) => JSON.stringify({ ideas: [], notice: { text } });
    const model = scriptedModel(reply('Check the air quality in Singapore today and tell the user if it is unhealthy.'), reply('Check the cricket scores today.'), reply('Check the air quality in Singapore today.'));
    const { store, deps, inOwner } = await setup(model);
    await inOwner(async () => {
      await putRow(store, newRow(OWNER, 'PROACTIVE_PREFERENCES.md', '## Never tell me about\nCricket scores\n', 'user', '2026-10-01T00:00:00Z'));
    });
    const first = await inOwner(() => runDailyIdeas(deps, { ownerId: OWNER, checkpoint: {}, force: true }));
    const text = String(first.wake?.payload['text']);
    expect(text).toContain('Check the air quality in Singapore');
    expect(text).toContain('NEVER message about (hard rules, no exceptions):\n- Cricket scores (topic)');
    expect(text).not.toContain('/juno/PROACTIVE_PREFERENCES.md');
    expect((await inOwner(() => runDailyIdeas(deps, { ownerId: OWNER, checkpoint: {}, force: true }))).wake).toBeUndefined();
    await inOwner(async () => {
      for (let n = 0; n < 3; n += 1) await store.put('proactiveLog', { id: 'plog-' + String(n), ownerId: OWNER, kind: 'goal-checkin', date: '2026-10-15', at: '2026-10-15T0' + String(n) + ':00:00Z' });
    });
    expect((await inOwner(() => runDailyIdeas(deps, { ownerId: OWNER, checkpoint: {}, force: true }))).wake).toBeUndefined();
  });
});

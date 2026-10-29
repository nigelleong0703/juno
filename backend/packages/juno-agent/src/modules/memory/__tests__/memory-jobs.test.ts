/** The memory jobs and what hangs off them: items and views on a real Postgres (identity graph and memory items), a scripted model and a map-backed computer. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedPeople } from '@agent-desktop/memory-graph/testing';
import type { Store } from '../../../contracts/index.js';
import type { HomeComputer } from '../../../ports/computer/index.js';
import { runWithOwner, requestScopedStore } from '../../../owner-context.js';
import { createMemoryStore } from '../../../testing/store.js';
import { homeHash } from '../../home/paths.js';
import { getRow } from '../../home/mirror.js';
import { loadHomeView } from '../../home/service.js';
import { runChatDigest, type DigestCheckpoint } from '../../digest/job.js';
import { explainMemory } from '../explain.js';
import { forgetClaims } from '../forget.js';
import { runNightly } from '../jobs/nightly.js';
import type { JobDeps, JobModel } from '../jobs/types.js';
import { shortPersonId } from '../../people/pages.js';
import { searchMemory } from '../search.js';
import { listAll } from '../util.js';
import { portOf, startMemoryGraph, type MemoryGraphFixture } from './memory-graph-fixture.js';

const AGENT = 'agt-1';
const NOW = new Date('2026-10-14T10:00:00Z');
const usage = { inputTokens: 100, outputTokens: 20, costUsd: 0.001, costKnown: true };

let graph: MemoryGraphFixture;

beforeAll(async () => {
  graph = await startMemoryGraph();
});

afterAll(async () => {
  await graph.close();
});

/** A computer that keeps files in a map and hashes them like the real one. */
function fakeComputer(files = new Map<string, string>()): HomeComputer & { files: Map<string, string> } {
  files.set('.juno-sync', 'x');
  return {
    files,
    async snapshot() {
      return { synced: true, files: [...files].map(([path, content]) => ({ path, hash: homeHash(content), mtime: 1 })) };
    },
    async read(_agent, path) {
      const content = files.get(path);
      return content === undefined ? null : { content, hash: homeHash(content) };
    },
    async write(_agent, path, content) {
      files.set(path, content);
      return { hash: homeHash(content) };
    },
    async putFile() {
      return { hash: 'h', written: true };
    },
    async extractText() {
      return { text: '', truncated: false };
    },
    async delete(_agent, path) {
      files.delete(path);
    },
    async ensure(_agent, path) {
      if (!files.has(path)) files.set(path, '');
    },
  };
}

/** A model that answers from a queue and remembers what it was asked. */
function scriptedModel(...answers: Array<string | null>): JobModel & { prompts: string[]; systems: string[] } {
  const prompts: string[] = [];
  const systems: string[] = [];
  return {
    prompts,
    systems,
    async complete(input) {
      prompts.push(input.prompt);
      systems.push(input.system);
      const text = answers.shift();
      return text === undefined || text === null ? null : { text, usage, model: 'test-model' };
    },
  };
}

/** One owner with an agent, an owner person, Alice (a Telegram contact), Noor (a person with no account) and a short conversation (c1, the owner's direct chat). */
async function setup(model: ReturnType<typeof scriptedModel>) {
  const owner = 'owner-' + randomUUID();
  const store: Store = requestScopedStore(createMemoryStore());
  const computer = fakeComputer();
  const people = await seedPeople(graph.db, owner, { ownerName: 'Owner', contacts: [{ name: 'Alice', accounts: [{ platform: 'telegram', externalId: 'user-9' }] }] });
  const noor = await graph.graph.identity.createPerson(owner, 'Noor');
  const alice = people.contacts[0]?.person.id ?? '';
  const deps: JobDeps = { store, home: computer, model, now: () => NOW, memory: graph.graph };
  await runWithOwner(owner, async () => {
    await store.put('agents', { id: AGENT, name: 'Juno', ownerId: owner, createdAt: '2026-01-01T00:00:00Z' } as never);
    await store.put('conversations', { id: 'c1', kind: 'direct', agentIds: [AGENT], memberIds: [owner], ownerId: owner, title: 'Juno', unreadCount: 0, lastItemAt: NOW.toISOString(), createdAt: '2026-10-01T00:00:00Z' } as never);
    await store.put('items', { id: 'itm-1', conversationId: 'c1', at: '2026-10-14T08:00:00Z', type: 'user_message', authorId: owner, text: 'I moved to Leiden last spring. I am vegetarian.', attachments: [], mentions: [] });
    await store.put('items', { id: 'itm-2', conversationId: 'c1', at: '2026-10-14T08:01:00Z', type: 'agent_message', agentId: AGENT, markdown: 'Nice. You said you like cycling too.', citations: [] });
    // A stranger on a platform: stored under the synthetic id of the speaker (never the owner's id), so it is read as someone else's word.
    await store.put('items', { id: 'itm-3', conversationId: 'c1', at: '2026-10-14T08:02:00Z', type: 'user_message', authorId: 'ext-telegram-0123456789abcdef', text: 'Alice drinks only tea.', attachments: [], mentions: [], channelSender: { kind: 'telegram', externalId: 'user-9', name: 'Alice', role: 'stranger' } });
  });
  return {
    owner, store, computer, deps, model, alice, noor: noor.id, ownerPerson: people.owner.id,
    inOwner: <T>(fn: () => Promise<T>): Promise<T> => runWithOwner(owner, fn),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** One chat digest of the setup's conversation, from a checkpoint, with the setup's deps unless others are given. */
const digest = (s: Setup, checkpoint: DigestCheckpoint = {}, deps: JobDeps = s.deps) =>
  s.inOwner(() => runChatDigest({ ...deps, memory: portOf(graph, s.store) }, { ownerId: s.owner, agentId: AGENT, agents: [{ id: AGENT, name: 'Juno' }], conversationId: 'c1', checkpoint }));

const claim = (text: string, itemId: string, quote: string, extra: Record<string, unknown> = {}) => ({ text, evidence: [{ itemId, quote }], confidence: 0.9, target: 'memory', ...extra });
const receiptOf = (s: Setup, day = '2026-10-14') => s.computer.files.get('self_improvement/' + day + '-digest.md') ?? '';

describe('chat digest: memory claims', () => {
  it('writes only claims whose quote is in the user\'s own words, as items, and renders the views from them; skips when nothing is new', async () => {
    const model = scriptedModel(JSON.stringify({ memory: [
      claim('Lives in Leiden.', 'itm-1', 'moved to Leiden'),
      claim('Is vegetarian.', 'itm-1', 'I am vegan'),
      claim('Likes cycling.', 'itm-2', 'like cycling'),
      claim('Drinks only tea.', 'itm-3', 'drinks only tea'),
      claim('Maybe owns a bike.', 'itm-1', 'moved to Leiden', { confidence: 0.2, target: 'preferences' }),
      claim('Has a sister called Noor.', 'itm-1', 'Leiden', { target: 'person:Noor' }),
      claim('Alice likes being greeted by name.', 'itm-3', 'drinks only tea', { target: 'person:Alice', forAgent: AGENT }),
    ] }));
    const s = await setup(model);
    const result = await digest(s);
    expect(result).toEqual({ outcome: 'done', checkpoint: { itemsAt: '2026-10-14T08:02:00Z' } });
    // Someone else's message and the assistant's are shown, but marked: neither is the user's word.
    expect(s.model.prompts[0]).toContain('[itm-1] USER');
    expect(s.model.prompts[0]).toContain('[itm-2] ASSISTANT (context only)');
    expect(s.model.prompts[0]).toContain('[itm-3] OTHER SENDER Alice (' + shortPersonId(s.alice) + ')');
    expect(s.model.prompts[0]).toContain('## People (id: name)');

    const claims = await s.inOwner(() => listAll(s.store, 'memoryClaims'));
    expect(claims.map((entry) => entry.text).sort()).toEqual(['Alice likes being greeted by name.', 'Has a sister called Noor.', 'Lives in Leiden.']);
    const sheet = s.computer.files.get('MEMORY.md') ?? '';
    const lived = claims.find((entry) => entry.text === 'Lives in Leiden.');
    expect(sheet).toBe('# Memory\n\n- Lives in Leiden. [claim:' + lived?.id + ']\n');
    expect(s.computer.files.get('people/' + s.noor + '.md')).toContain('# Noor');
    // A stranger's words reach only a person's page, in the section of the agent that dealt with them; and only that agent's search sees it.
    expect(s.computer.files.get('people/' + s.alice + '.md')).toMatch(/^# Alice\n\n## Juno（agt-1）\n- Alice likes being greeted by name\. \[claim:/);
    expect(sheet).not.toContain('tea');

    // The claims are stored as active items with their labels: the owner said the Leiden fact, Alice said hers.
    const items = await s.inOwner(() => graph.graph.items.listItems(s.owner, { status: 'active' }));
    expect(items.map((item) => item.text).sort()).toEqual(['Alice likes being greeted by name.', 'Has a sister called Noor.', 'Lives in Leiden.']);
    expect(items.find((item) => item.text === 'Lives in Leiden.')).toMatchObject({ file: 'memory', kind: 'fact', aboutPersonId: s.ownerPerson, saidByPersonId: s.ownerPerson, saidIn: 'app', audience: 'owner', claimId: lived?.id });
    expect(items.find((item) => item.text === 'Alice likes being greeted by name.')).toMatchObject({ file: 'person', agentId: AGENT, aboutPersonId: s.alice, saidByPersonId: s.alice });

    // Search reads the items: this agent finds its own private note about Alice, another agent of the owner does not.
    const search = (agentId: string) => s.inOwner(() => searchMemory(graph.graph, { ownerId: s.owner, presence: { kind: 'owner' }, agentId, query: 'greeted', limit: 5 }));
    expect((await search(AGENT)).map((hit) => hit.item.text)).toEqual(['Alice likes being greeted by name.']);
    expect(await search('agt-2')).toEqual([]);
    expect((await s.inOwner(() => getRow(s.store, s.owner, 'MEMORY.md')))?.content).toBe(sheet);
    expect(receiptOf(s)).toContain('the quote is not in its source: Is vegetarian.');
    expect((await s.inOwner(() => listAll(s.store, 'runs')))[0]).toMatchObject({ kind: 'background', agentId: AGENT, usage: { inputTokens: 100, costUsd: 0.001 } });

    // Nothing new since the checkpoint: no model call.
    const again = await digest(s, result.checkpoint);
    expect(again.outcome).toBe('skipped');
    expect(s.model.prompts).toHaveLength(1);

    // memory_explain finds the claim and the user's words by the tag on the line.
    const explained = await s.inOwner(() => explainMemory(graph.graph, s.store, { ownerId: s.owner, presence: { kind: 'owner' }, agentId: AGENT, reference: { kind: 'claim', id: lived?.id ?? '' } }));
    expect(explained).toMatchObject({ kind: 'claim', claim: { id: lived?.id }, evidence: [{ quote: 'moved to Leiden', source: { kind: 'message', conversationId: 'c1' } }] });
    // A stranger's presence does not see the owner's memory, so the same tag is not found for it.
    expect(await s.inOwner(() => explainMemory(graph.graph, s.store, { ownerId: s.owner, presence: { kind: 'other' }, agentId: AGENT, reference: { kind: 'claim', id: lived?.id ?? '' } }))).toMatchObject({ kind: 'not_found' });
  });

  it('makes the person of a sender with no person when their own words back a claim the target names them in', async () => {
    const model = scriptedModel(JSON.stringify({ memory: [claim('Is vegetarian.', 'itm-4', "I'm vegetarian", { target: 'person:Bob' })] }));
    const s = await setup(model);
    // Bob spoke in a group nobody addressed the agent in: he has an account and no person.
    await s.inOwner(() => graph.graph.identity.upsertAccount(s.owner, { platform: 'telegram', externalId: 'user-bob', name: 'Bob' }, { createPerson: false }));
    await s.inOwner(() => s.store.put('items', { id: 'itm-4', conversationId: 'c1', at: '2026-10-14T08:03:00Z', type: 'user_message', authorId: 'ext-telegram-bob', text: "I'm vegetarian, so skip the meat.", attachments: [], mentions: [], channelSender: { kind: 'telegram', externalId: 'user-bob', name: 'Bob', role: 'stranger' } }));
    expect(await digest(s)).toMatchObject({ outcome: 'done' });
    // Bob's person is made from his account, and the claim is written on his page, said by him.
    const bob = (await graph.graph.identity.listPeople(s.owner)).find((person) => person.name === 'Bob');
    expect(bob).toBeDefined();
    const items = await s.inOwner(() => graph.graph.items.listItems(s.owner, { status: 'active' }));
    expect(items.find((item) => item.text === 'Is vegetarian.')).toMatchObject({ file: 'person', aboutPersonId: bob?.id, saidByPersonId: bob?.id });
    expect(s.computer.files.get('people/' + bob?.id + '.md')).toMatch(/^# Bob\n\n- Is vegetarian\. \[claim:/);
  });

  it('does not make a person from a name that is not the sender\'s: the claim names someone else and is not written', async () => {
    const model = scriptedModel(JSON.stringify({ memory: [claim('Is vegetarian.', 'itm-4', "I'm vegetarian", { target: 'person:Carol' })] }));
    const s = await setup(model);
    await s.inOwner(() => graph.graph.identity.upsertAccount(s.owner, { platform: 'telegram', externalId: 'user-bob', name: 'Bob' }, { createPerson: false }));
    await s.inOwner(() => s.store.put('items', { id: 'itm-4', conversationId: 'c1', at: '2026-10-14T08:03:00Z', type: 'user_message', authorId: 'ext-telegram-bob', text: "I'm vegetarian, so skip the meat.", attachments: [], mentions: [], channelSender: { kind: 'telegram', externalId: 'user-bob', name: 'Bob', role: 'stranger' } }));
    await digest(s);
    const people = await graph.graph.identity.listPeople(s.owner);
    expect(people.some((person) => person.name === 'Bob')).toBe(false);
    const items = await s.inOwner(() => graph.graph.items.listItems(s.owner, { status: 'active' }));
    expect(items.find((item) => item.text === 'Is vegetarian.')).toBeUndefined();
  });

  it('makes a page for a person the owner names, even without an account, from the owner\'s own words', async () => {
    const model = scriptedModel(JSON.stringify({ memory: [claim('Lily loves sushi.', 'itm-1', 'moved to Leiden', { target: 'person:Lily' })] }));
    const s = await setup(model);
    expect(await digest(s)).toMatchObject({ outcome: 'done' });
    // The person is made once, with no account, and the claim lands on her page, headed by her name.
    const lily = (await graph.graph.identity.listPeople(s.owner)).find((person) => person.name === 'Lily');
    expect(lily).toBeDefined();
    expect(s.computer.files.get('people/' + lily?.id + '.md')).toMatch(/^# Lily\n\n- Lily loves sushi\. \[claim:/);
  });

  it('keeps the checkpoint when the model fails, replaces a superseded item, and never writes a forgotten claim again', async () => {
    const first = JSON.stringify({ memory: [claim('Lives in Leiden.', 'itm-1', 'moved to Leiden'), claim('Is vegetarian.', 'itm-1', 'I am vegetarian')] });
    const model = scriptedModel(null, first);
    const s = await setup(model);
    const failed = await digest(s);
    expect(failed).toMatchObject({ outcome: 'failed', checkpoint: {} });
    expect(s.computer.files.has('MEMORY.md')).toBe(false);

    await digest(s);
    const [leiden, vegetarian] = ['Lives in Leiden.', 'Is vegetarian.'].map((text) => (s.computer.files.get('MEMORY.md') ?? '').split('\n').find((line) => line.startsWith('- ' + text)) ?? '');
    const idOf = (line: string): string => /\[claim:(\w+)\]/.exec(line)?.[1] ?? '';

    // A newer message moves the user; the new line replaces the old one (the old item is retracted, the new one is active).
    await s.inOwner(() => s.store.put('items', { id: 'itm-4', conversationId: 'c1', at: '2026-10-14T09:00:00Z', type: 'user_message', authorId: s.owner, text: 'We just moved to Utrecht, to a flat near the canal.', attachments: [], mentions: [] }));
    // The digest names the existing item it replaces by its id (the prompt lists the items closest to the conversation with their ids).
    const [leidenItem] = await graph.graph.items.listItems(s.owner, { claimId: idOf(leiden ?? '') });
    const updated = scriptedModel(JSON.stringify({ memory: [claim('Lives in Utrecht.', 'itm-4', 'moved to Utrecht', { supersedes: leidenItem?.id })] }));
    await digest(s, { itemsAt: '2026-10-14T08:02:00Z' }, { ...s.deps, model: updated });
    const lines = (s.computer.files.get('MEMORY.md') ?? '').split('\n');
    // Both lines are in the sheet (items made at the same instant come out in no fixed order).
    expect(lines).toEqual(expect.arrayContaining([vegetarian, expect.stringMatching(/^- Lives in Utrecht\. \[claim:/)]));
    expect(s.computer.files.get('MEMORY.md')).not.toContain('Leiden');
    expect((await s.inOwner(() => s.store.get('memoryClaims', idOf(leiden ?? ''))))?.status).toBe('superseded');

    // The user forgets "vegetarian": the line, its item and its claim go, and the digest cannot bring it back.
    const forgotten = await s.inOwner(() => forgetClaims(s.deps, { ownerId: s.owner, agentId: AGENT, claimIds: [idOf(vegetarian ?? ''), 'clm_unknown'] }));
    expect(forgotten).toEqual({ retracted: 1, removedLines: 1 });
    expect(s.computer.files.get('MEMORY.md')).not.toContain('vegetarian');
    expect((await s.inOwner(() => s.store.get('memoryClaims', idOf(vegetarian ?? ''))))?.status).toBe('retracted');
    // The same message is read again (a retried run) and the model words the claim differently: still the forgotten one.
    const repeat = scriptedModel(JSON.stringify({ memory: [claim('The user eats no meat', 'itm-1', 'I am vegetarian')] }));
    await digest(s, {}, { ...s.deps, model: repeat });
    expect(receiptOf(s)).toContain('the user retracted this: The user eats no meat');
    expect(s.computer.files.get('MEMORY.md')).not.toContain('vegetarian');
  });

  it('never takes a daily-log note or an agent\'s post in a platform chat as evidence (the diet-planner incident)', async () => {
    const model = scriptedModel(JSON.stringify({ memory: [
      claim('The user wants the assistant to be their diet planner.', 'log:memory/2026-10-14/agt-2.md', 'Wants me to be their diet planner', { target: 'preferences', basis: 'explicit' }),
      claim('The user likes Atlas.', 'itm-4', 'I like Atlas', { target: 'preferences', basis: 'explicit' }),
    ] }));
    const s = await setup(model);
    await s.inOwner(async () => {
      // Another of the owner's agents speaking in Discord is stored as a user_message from `agent:<id>`: agent text, not an unknown human.
      await s.store.put('items', { id: 'itm-4', conversationId: 'c1', at: '2026-10-14T08:03:00Z', type: 'user_message', authorId: 'ext-discord-0123456789abcdef', text: 'I like Atlas', attachments: [], mentions: [], channelSender: { kind: 'discord', externalId: 'agent:agt-9', name: 'Atlas', role: 'stranger' } });
    });
    const result = await digest(s, { itemsAt: '2026-10-14T08:02:00Z' });
    expect(result).toMatchObject({ outcome: 'skipped' });
    // Only the agent's post is new since the checkpoint: no owner words, so no model call and nothing written.
    expect(s.model.prompts).toHaveLength(0);
    const again = await digest(s, {});
    expect(again).toMatchObject({ outcome: 'done' });
    expect(s.model.prompts[0]).toContain('[itm-4] ASSISTANT (context only)');
    const receipt = receiptOf(s);
    expect(receipt).toContain('a daily-log note is not evidence; quote the user\'s own message: The user wants the assistant to be their diet planner.');
    expect(receipt).toContain('the quote is not in its source: The user likes Atlas.');
    expect(s.computer.files.has('memory/bank/preferences.md')).toBe(false);
    expect(await s.inOwner(() => listAll(s.store, 'memoryClaims'))).toEqual([]);
  });

  it('with many items, shows the model only the closest to the conversation (any source), not the whole memory', async () => {
    const model = scriptedModel(JSON.stringify({ memory: [] }));
    const s = await setup(model);
    await s.inOwner(async () => {
      for (let i = 0; i < 20; i += 1) await graph.graph.items.addItem(s.owner, { id: 'mem_filler' + String(i), text: 'Filler note number ' + String(i), kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner', aboutPersonId: s.ownerPerson });
      await graph.graph.items.addItem(s.owner, { id: 'mem_leiden', text: 'Used to live in Leiden before the move', kind: 'fact', file: 'memory', saidIn: 'migrated', audience: 'owner', aboutPersonId: s.ownerPerson });
    });
    await digest(s);
    const listed = (model.prompts[0] ?? '').split('\n').filter((line) => line.startsWith('mem_'));
    expect(listed.some((line) => line.startsWith('mem_leiden | the person being helped | Used to live in Leiden'))).toBe(true);
    expect(listed.length).toBeLessThan(21);
  });

  it('shows the model the existing items closest to the chat, and writes per fact: skip what is already there, replace what changed, add what is new', async () => {
    const at = '2026-09-01T00:00:00.000Z';
    const existing = (id: string, text: string, extra: Record<string, unknown> = {}) =>
      graph.graph.items.addItem(s.owner, { id, text, kind: 'fact', file: 'memory', saidIn: 'migrated', audience: 'owner', createdAt: at, ...extra });
    const model = scriptedModel(JSON.stringify({ memory: [
      // Said again in other words: an item with no claim (migrated) already says it, so nothing new is written and the item is seen again.
      claim('Eats no meat.', 'itm-1', 'I am vegetarian', { sameAs: 'mem_veg', topic: 'health' }),
      // A change: the old item (no claim either) is replaced by the new wording and retracted.
      claim('Moved to Leiden.', 'itm-1', 'moved to Leiden', { supersedes: 'mem_city', topic: 'home' }),
      // The model names an item of a group: a fact from this chat never replaces or joins what was said in a group.
      claim('Likes tea.', 'itm-1', 'moved to Leiden', { supersedes: 'mem_group', topic: 'preferences' }),
      claim('Has a bike.', 'itm-1', 'moved to Leiden', { sameAs: 'mem_unknown' }),
    ] }));
    const s = await setup(model);
    await s.inOwner(async () => {
      await existing('mem_veg', 'Is vegetarian', { aboutPersonId: s.ownerPerson });
      await existing('mem_city', 'Lives in Utrecht', { aboutPersonId: s.ownerPerson });
      await existing('mem_group', 'Likes tea, the gym group knows', { aboutPersonId: s.ownerPerson, audience: 'group:g1', saidIn: 'group:g1' });
    });
    expect((await digest(s)).outcome).toBe('done');
    // The prompt lists the items of this chat's audience with their ids, and none of the group's.
    expect(model.prompts[0]).toContain('mem_veg | the person being helped | Is vegetarian');
    expect(model.prompts[0]).toContain('mem_city | the person being helped | Lives in Utrecht');
    expect(model.prompts[0]).not.toContain('gym group');
    const itemOf = (id: string) => graph.graph.items.getItem(s.owner, id);
    const receipt = receiptOf(s);
    expect(receipt).toContain('Rejected already known (same as mem_veg): Eats no meat.');
    expect((await itemOf('mem_veg'))?.evidence).toEqual([{ itemId: 'itm-1', quote: 'I am vegetarian' }]);
    expect(await itemOf('mem_city')).toMatchObject({ status: 'retracted' });
    expect(await itemOf('mem_group')).toMatchObject({ status: 'active', text: 'Likes tea, the gym group knows', audience: 'group:g1' });
    const texts = (await graph.graph.items.listItems(s.owner, { status: 'active' })).map((item) => [item.text, item.topic, item.audience]);
    expect(texts).toEqual(expect.arrayContaining([['Moved to Leiden.', 'home', 'owner'], ['Likes tea.', 'preferences', 'owner'], ['Has a bike.', null, 'owner']]));
    expect(texts).not.toContainEqual(['Eats no meat.', 'health', 'owner']);
  });

  it('labels a claim\'s old log evidence by its real source in memory_explain', async () => {
    const s = await setup(scriptedModel());
    const at = '2026-10-14T08:00:00.000Z';
    await s.inOwner(async () => {
      await s.store.put('memoryClaims', { id: 'clm_old', ownerId: s.owner, text: 'The user wants a diet planner.', evidence: [{ itemId: 'log:memory/2026-10-14/agt-2.md', quote: 'diet planner' }, { itemId: 'itm-1', quote: 'moved to Leiden' }, { itemId: 'itm-3', quote: 'tea' }], confidence: 0.9, status: 'active', target: { path: 'MEMORY.md' }, createdAt: at, updatedAt: at }, { status: 'active' });
    });
    // The claim is explained through the memory it produced: an item that carries its claim id.
    await graph.graph.items.addItem(s.owner, { text: 'The user wants a diet planner.', kind: 'plan', file: 'memory', saidIn: 'app', audience: 'owner', claimId: 'clm_old', evidence: [{ itemId: 'itm-1', quote: 'moved to Leiden' }], createdAt: at });
    const explained = await s.inOwner(() => explainMemory(graph.graph, s.store, { ownerId: s.owner, presence: { kind: 'owner' }, agentId: AGENT, reference: { kind: 'claim', id: 'clm_old' } }));
    expect(explained).toMatchObject({ kind: 'claim', evidence: [{ source: { kind: 'log' } }, { source: { kind: 'message', speaker: 'owner' } }, { source: { kind: 'message', speaker: 'someone else' } }] });
  });
});

describe('nightly job', () => {
  it('writes the dream and a synthesis with only live agents and unretracted claims, then skips until something new happens', async () => {
    const s = await setup(scriptedModel('## What I noticed\nShort messages.', '# How to talk\n- Keep it short. [claim:clm_live]\n- Formal. [claim:clm_dead]\n## Juno（agt-1）\n- Dutch.\n## Gone（agt-9）\n- Secret.'));
    await s.inOwner(async () => {
      await s.store.put('memoryClaims', { id: 'clm_live', ownerId: s.owner, text: 'Short', evidence: [{ itemId: 'itm-1', quote: 'q' }], confidence: 1, status: 'active', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
      await s.store.put('memoryClaims', { id: 'clm_dead', ownerId: s.owner, text: 'Formal', evidence: [{ itemId: 'itm-1', quote: 'q' }], confidence: 1, status: 'retracted', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    });
    const input = { ownerId: s.owner, agentId: AGENT, agents: [{ id: AGENT, name: 'Juno' }], checkpoint: {} };
    const done = await s.inOwner(() => runNightly(s.deps, input));
    expect(done.outcome).toBe('done');
    expect(s.computer.files.get('dreams/2026-10-14.md')).toContain('Short messages.');
    const synthesis = s.computer.files.get('ALIGNMENT_SYNTHESIS.md') ?? '';
    expect(synthesis).toContain('- Keep it short. [claim:clm_live]');
    expect(synthesis).toContain('Dutch.');
    expect(synthesis).not.toContain('Formal');
    expect(synthesis).not.toContain('Secret');
    expect(s.computer.files.get('self_improvement/2026-10-14-dream.md')).toContain('Rewrote ALIGNMENT_SYNTHESIS.md');
    expect((await s.inOwner(() => runNightly(s.deps, { ...input, checkpoint: done.checkpoint }))).outcome).toBe('skipped');
  });
});

describe('what counts as a preference', () => {
  it('keeps one-off task requests out of preferences and circumstances, and merges two explicit statements into one claim', async () => {
    const asks = ['我想买 Apple 最便宜的 Mac mini', '帮我关注 Apple 的最新动态，整理成 feed 发给我', '每周帮我看 OpenAI 和 Anthropic 的动态', '希望每天获得 AI 新闻'];
    const ids = ['itm-a', 'itm-b', 'itm-c', 'itm-d'];
    const request = (text: string, itemId: string, quote: string) => claim(text, itemId, quote, { target: 'preferences', basis: 'request' });
    const model = scriptedModel(JSON.stringify({ memory: [
      request('用户想购买 Apple 最便宜的 Mac mini。', 'itm-a', asks[0] ?? ''),
      request('用户会关注 Apple 的最新动态。', 'itm-b', asks[1] ?? ''),
      claim('用户会关注 OpenAI 和 Anthropic 的每周动态。', 'itm-c', asks[2] ?? '', { target: 'circumstances' }),
      // A model that calls one sighting a pattern is still not enough: it needs two separate conversations.
      claim('用户希望每天获得 AI 新闻。', 'itm-d', asks[3] ?? '', { target: 'preferences', basis: 'pattern' }),
      claim('Prefers short answers.', 'itm-e1', 'I prefer short answers', { target: 'preferences', basis: 'explicit' }),
    ] }));
    const s = await setup(model);
    await s.inOwner(async () => {
      for (const [i, text] of asks.entries()) await s.store.put('items', { id: ids[i] ?? '', conversationId: 'c1', at: '2026-10-14T09:0' + String(i) + ':00Z', type: 'user_message', authorId: s.owner, text, attachments: [], mentions: [] });
      await s.store.put('items', { id: 'itm-e1', conversationId: 'c1', at: '2026-10-14T09:10:00Z', type: 'user_message', authorId: s.owner, text: 'I prefer short answers.', attachments: [], mentions: [] });
      await s.store.put('items', { id: 'itm-e2', conversationId: 'c1', at: '2026-10-14T09:20:00Z', type: 'user_message', authorId: s.owner, text: 'Always keep it short, please.', attachments: [], mentions: [] });
    });
    const first = await digest(s);
    expect(first.outcome).toBe('done');
    expect(receiptOf(s).match(/- Rejected /g)).toHaveLength(4);
    expect(receiptOf(s).match(/- Wrote /g)).toHaveLength(1);
    expect(s.computer.files.get('memory/bank/circumstances.md')).toBeUndefined();
    const [stored] = await s.inOwner(() => listAll(s.store, 'memoryClaims'));

    // Said again, explicitly, in another message: one claim with both quotes; the old item is retracted and the new one takes its place.
    const merge = scriptedModel(JSON.stringify({ memory: [claim('Prefers short answers.', 'itm-e2', 'Always keep it short', { target: 'preferences', basis: 'explicit', supersedes: stored?.id })] }));
    await digest(s, { itemsAt: '2026-10-14T09:09:00Z' }, { ...s.deps, model: merge });
    const claims = await s.inOwner(() => listAll(s.store, 'memoryClaims'));
    const live = claims.filter((entry) => entry.status === 'active');
    expect(live).toHaveLength(1);
    expect(live[0]?.evidence.map((entry) => entry.itemId).sort()).toEqual(['itm-e1', 'itm-e2']);
    expect((s.computer.files.get('memory/bank/preferences.md') ?? '').match(/claim:/g)).toHaveLength(1);
  });
});

describe('nightly tidy', () => {
  const old = '2026-08-01T00:00:00Z';
  const recent = '2026-10-10T00:00:00Z';
  const QUIET_DAY = new Date('2026-10-20T10:00:00Z');
  const run = (s: Setup, deps: JobDeps = s.deps, checkpoint: Parameters<typeof runNightly>[1]['checkpoint'] = {}) =>
    s.inOwner(() => runNightly(deps, { ownerId: s.owner, agentId: AGENT, agents: [{ id: AGENT, name: 'Juno' }], checkpoint }));
  /** An item with fixed id and creation instant; a claim row alongside when `claim` is given. */
  const seed = async (s: Setup, input: { id: string; text: string; at: string; claim?: string; file?: 'memory' | 'bank:preferences'; audience?: string; saidIn?: string; about?: string | null; topic?: 'health' }) => {
    await s.inOwner(async () => {
      if (input.claim !== undefined) {
        await s.store.put('memoryClaims', { id: input.claim, ownerId: s.owner, text: input.text, evidence: [{ itemId: 'itm-' + input.claim, quote: input.text }], confidence: 0.9, status: 'active', target: { path: 'memory/bank/preferences.md' }, createdAt: input.at, updatedAt: input.at }, { status: 'active' });
      }
      await graph.graph.items.addItem(s.owner, {
        id: input.id, text: input.text, kind: 'preference', file: input.file ?? 'bank:preferences', saidIn: input.saidIn ?? 'app', audience: input.audience ?? 'owner', createdAt: input.at,
        aboutPersonId: input.about === undefined ? s.ownerPerson : input.about,
        ...(input.claim === undefined ? {} : { claimId: input.claim, evidence: [{ itemId: 'itm-' + input.claim, quote: input.text }] }), ...(input.topic === undefined ? {} : { topic: input.topic }),
      });
    });
  };
  const itemOf = (s: Setup, id: string) => graph.graph.items.getItem(s.owner, id);

  it('merges duplicates of every source with the newest wording, expires only items unseen for 30 days, sorts and rewords, writes the summaries and keeps the to-confirm list', async () => {
    const proposal = JSON.stringify({
      merge: [
        { keep: 'mem_a', drop: ['mem_b'], text: 'Prefers short answers.', topic: 'preferences' },
        // A migrated line with no claim and a claimed one: the items are merged whatever their source.
        { keep: 'mem_m1', drop: ['mem_m2'], text: 'Portfolio demos show the full phone screen.', topic: 'work' },
      ],
      stale: ['mem_old', 'mem_new'],
      confirm: ['Still vegetarian?'],
      fix: [{ id: 'mem_sugar', topic: 'health', text: 'Wants less sugar.' }, { id: 'mem_fine', topic: 'other' }],
    });
    const summaries = JSON.stringify({ summaries: { preferences: "You like short answers and tea.", health: "You're [[mem_sugar|cutting sugar]] and [[mem_m2|show demos]]; [[mem_made_up|nothing else]].", work: 'Your portfolio demos show the [[mem_m2|full phone screen]].', home: 'Not a topic that was due.' } });
    const model = scriptedModel(proposal, summaries, '## What I noticed\nShort.', '# How to talk\n- Short.');
    const s = await setup(model);
    await seed(s, { id: 'mem_a', text: 'Likes brief replies.', at: '2026-08-01T00:00:01Z', claim: 'clm_a' });
    await seed(s, { id: 'mem_b', text: 'Wants short answers.', at: '2026-08-01T00:00:02Z', claim: 'clm_b' });
    await seed(s, { id: 'mem_old', text: 'Reads at night.', at: old, claim: 'clm_old' });
    await seed(s, { id: 'mem_new', text: 'Likes tea.', at: old, claim: 'clm_new' });
    await s.inOwner(() => s.store.put('memoryClaims', { id: 'clm_new', ownerId: s.owner, text: 'Likes tea.', evidence: [], confidence: 0.9, status: 'active', createdAt: old, updatedAt: recent }, { status: 'active' }));
    await seed(s, { id: 'mem_m1', text: 'Portfolio demos show the full phone screen', at: '2026-08-01T00:00:03Z', saidIn: 'migrated', file: 'memory' });
    await seed(s, { id: 'mem_m2', text: 'Portfolio demos should show the whole phone', at: '2026-08-01T00:00:04Z', claim: 'clm_m2', file: 'memory' });
    await seed(s, { id: 'mem_sugar', text: 'User wants less sugar in their diet', at: recent, saidIn: 'migrated', file: 'memory' });
    await seed(s, { id: 'mem_fine', text: 'Lives in Leiden.', at: recent, file: 'memory', topic: 'health' });

    const result = await run(s);
    expect(result.outcome).toBe('done');
    const claims = new Map((await s.inOwner(() => listAll(s.store, 'memoryClaims'))).map((entry) => [entry.id, entry]));
    // The newer of the two survives with the merged wording and both quotes; the older is superseded; the fresh claim is not expired.
    expect(await itemOf(s, 'mem_b')).toMatchObject({ status: 'active', text: 'Prefers short answers.', topic: 'preferences' });
    expect((await itemOf(s, 'mem_b'))?.evidence).toHaveLength(2);
    expect(await itemOf(s, 'mem_a')).toMatchObject({ status: 'retracted' });
    expect(claims.get('clm_b')).toMatchObject({ status: 'active', text: 'Prefers short answers.' });
    expect(claims.get('clm_b')?.evidence).toHaveLength(2);
    expect(claims.get('clm_a')?.status).toBe('superseded');
    expect(await itemOf(s, 'mem_old')).toMatchObject({ status: 'retracted' });
    expect(claims.get('clm_old')?.status).toBe('superseded');
    expect(await itemOf(s, 'mem_new')).toMatchObject({ status: 'active' });
    expect(claims.get('clm_new')?.status).toBe('active');
    // The migrated line (no claim) and the claimed one merge: the newer survives, the claim follows the wording.
    expect(await itemOf(s, 'mem_m2')).toMatchObject({ status: 'active', text: 'Portfolio demos show the full phone screen.', topic: 'work' });
    expect(await itemOf(s, 'mem_m1')).toMatchObject({ status: 'retracted' });
    expect(claims.get('clm_m2')).toMatchObject({ status: 'active', text: 'Portfolio demos show the full phone screen.' });
    // The old wording is rewritten and sorted; an item that already has a topic keeps it.
    expect(await itemOf(s, 'mem_sugar')).toMatchObject({ text: 'Wants less sugar.', topic: 'health', audience: 'owner' });
    expect(await itemOf(s, 'mem_fine')).toMatchObject({ text: 'Lives in Leiden.', topic: 'health' });
    expect(s.computer.files.get('memory/bank/preferences.md')).toBe('# Preferences\n\n- Likes tea. [claim:clm_new]\n- Prefers short answers. [claim:clm_b]\n');
    expect(s.computer.files.get('memory/to-confirm.md')).toContain('- Still vegetarian?');
    // A summary only for each topic that was due, in the words the model gave; a topic nobody asked for is not written.
    const written = new Map((await graph.graph.items.listTopicSummaries(s.owner)).map((entry) => [entry.topic, entry.summary]));
    // Markers are stored for items the model was shown; a made-up id (or an item of another topic) is dropped to plain text.
    expect(written.get('health')).toBe("You're [[mem_sugar|cutting sugar]] and show demos; nothing else.");
    expect(written.get('work')).toBe('Your portfolio demos show the [[mem_m2|full phone screen]].');
    // The prompt asks for the markers and lists each line with its id.
    const askedSystem = model.systems.find((text) => text.includes('summaries'));
    expect(askedSystem).toContain('[[<id>|<those words>]]');
    expect(model.prompts.find((text) => text.includes('Lines:'))).toContain('- mem_sugar | Wants less sugar.');
    expect(written.has('home')).toBe(false);
    expect(result.checkpoint).toMatchObject({ tidyVersion: 1 });
  });

  it('tidies on a quiet day when the memory changed, and not again until it changes', async () => {
    const proposal = JSON.stringify({ merge: [{ keep: 'mem_x', drop: ['mem_y'], text: 'Wants to build muscle.', topic: 'health' }], fix: [] });
    const quiet = scriptedModel(proposal, JSON.stringify({ summaries: { health: "You're building muscle." } }), JSON.stringify({ merge: [], fix: [] }), JSON.stringify({ summaries: { health: "You're building muscle and cutting sugar." } }));
    const s = await setup(quiet);
    const deps = { ...s.deps, now: () => QUIET_DAY };
    await seed(s, { id: 'mem_x', text: "Main fitness goal is to build muscle", at: '2026-10-01T00:00:01Z', saidIn: 'migrated', topic: 'health' });
    await seed(s, { id: 'mem_y', text: 'Wants to work out more', at: '2026-10-01T00:00:02Z', claim: 'clm_y', topic: 'health' });

    // No chat in the last day (the setup's messages are from the 14th), yet the memory is tidied and summarised; no dream, no synthesis.
    const first = await run(s, deps);
    expect(first.outcome).toBe('done');
    expect(quiet.prompts).toHaveLength(2);
    expect(s.computer.files.has('ALIGNMENT_SYNTHESIS.md')).toBe(false);
    expect([...s.computer.files.keys()].some((path) => path.startsWith('dreams/'))).toBe(false);
    expect(await itemOf(s, 'mem_y')).toMatchObject({ status: 'active', text: 'Wants to build muscle.' });
    expect(await itemOf(s, 'mem_x')).toMatchObject({ status: 'retracted' });
    expect((await graph.graph.items.listTopicSummaries(s.owner)).map((entry) => entry.summary)).toEqual(["You're building muscle."]);

    // Nothing changed since: skipped without a model call.
    expect((await run(s, deps, first.checkpoint)).outcome).toBe('skipped');
    expect(quiet.prompts).toHaveLength(2);
    // A note arrives: the next night tidies and rewrites the health summary.
    await s.inOwner(() => graph.graph.items.addItem(s.owner, { text: 'Wants less sugar', kind: 'preference', file: 'bank:preferences', saidIn: 'app', audience: 'owner', aboutPersonId: s.ownerPerson, topic: 'health' }));
    const third = await run(s, deps, first.checkpoint);
    expect(third.outcome).toBe('done');
    expect(quiet.prompts).toHaveLength(4);
    expect((await graph.graph.items.listTopicSummaries(s.owner)).map((entry) => entry.summary)).toEqual(["You're building muscle and cutting sugar."]);
  });

  it('never merges across audiences or people, and never lets a summary read a group\'s items', async () => {
    const proposal = JSON.stringify({
      merge: [{ keep: 'mem_own', drop: ['mem_grp'], text: 'Likes tea.', topic: 'preferences' }, { keep: 'mem_own', drop: ['mem_pri'], text: 'Likes tea.', topic: 'preferences' }],
      fix: [], stale: [],
    });
    const model = scriptedModel(proposal, JSON.stringify({ summaries: { preferences: 'You like tea.' } }));
    const s = await setup(model);
    const deps = { ...s.deps, now: () => QUIET_DAY };
    await seed(s, { id: 'mem_own', text: 'Likes tea', at: '2026-10-01T00:00:01Z', topic: 'health' });
    await seed(s, { id: 'mem_grp', text: 'Likes tea, said in the gym group', at: '2026-10-01T00:00:02Z', audience: 'group:g1', saidIn: 'group:g1', topic: 'health' });
    await seed(s, { id: 'mem_pri', text: 'Priya likes tea', at: '2026-10-01T00:00:03Z', about: s.alice, topic: 'health' });
    expect((await run(s, deps)).outcome).toBe('done');
    for (const id of ['mem_own', 'mem_grp', 'mem_pri']) expect(await itemOf(s, id)).toMatchObject({ status: 'active' });
    expect(await itemOf(s, 'mem_grp')).toMatchObject({ audience: 'group:g1', text: 'Likes tea, said in the gym group' });
    // The summary prompt carries the owner's own item and not the group's.
    const summaryPrompt = model.prompts[1] ?? '';
    expect(summaryPrompt).toContain('Likes tea');
    expect(summaryPrompt).not.toContain('gym group');
  });

  it('leaves everything as it is when the model does not answer, and tries the backfill again the next night', async () => {
    const s = await setup(scriptedModel(null, JSON.stringify({ merge: [], fix: [{ id: 'mem_u', topic: 'plans', text: 'Plans a trip.' }] }), JSON.stringify({ summaries: {} })));
    const deps = { ...s.deps, now: () => QUIET_DAY };
    await seed(s, { id: 'mem_u', text: 'User plans a trip', at: '2026-10-01T00:00:01Z', file: 'memory' });
    const failed = await run(s, deps);
    expect(failed).toMatchObject({ outcome: 'failed', checkpoint: {} });
    expect(await itemOf(s, 'mem_u')).toMatchObject({ text: 'User plans a trip', topic: null });
    const retried = await run(s, deps, failed.checkpoint);
    expect(retried.outcome).toBe('done');
    expect(await itemOf(s, 'mem_u')).toMatchObject({ text: 'Plans a trip.', topic: 'plans' });
  });
});

describe('daily log of an agent that works for a teammate', () => {
  it('moves what the agent appended on the creator\'s computer to the teammate\'s mirror and restores the file', async () => {
    const store: Store = requestScopedStore(createMemoryStore());
    const computer = fakeComputer();
    const path = 'memory/2026-10-14/' + AGENT + '.md';
    const deps = { store, home: computer };
    const view = (talker: string) => runWithOwner(talker, () => loadHomeView(deps, { ownerId: talker, agentOwnerId: 'creator', agentId: AGENT, seq: 1, sync: true, now: NOW, timeZone: 'UTC' }));

    expect((await view('teammate')).dailyLog).toBe(path);
    expect(computer.files.get(path)).toBe('');
    computer.files.set(path, '- 09:00 Teammate likes tea\n');
    await view('teammate');
    expect(computer.files.get(path)).toBe('');
    const mine = await runWithOwner('teammate', () => getRow(store, 'teammate', path));
    expect(mine).toMatchObject({ content: '- 09:00 Teammate likes tea\n', pendingWrite: true, writer: 'agent' });
    expect(await runWithOwner('creator', () => getRow(store, 'creator', path))).toMatchObject({ content: '' });

    // The creator's own run keeps what the agent writes.
    computer.files.set(path, '- 10:00 Creator likes coffee\n');
    await runWithOwner('creator', () => loadHomeView(deps, { ownerId: 'creator', agentId: AGENT, seq: 2, sync: true, now: NOW, timeZone: 'UTC' }));
    expect(computer.files.get(path)).toBe('- 10:00 Creator likes coffee\n');
    expect((await runWithOwner('creator', () => getRow(store, 'creator', path)))?.content).toBe('- 10:00 Creator likes coffee\n');
  });
});

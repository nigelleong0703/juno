/**
 * What a run may read of the memory (batch 5a), on the embedded Postgres: who is present (presenceOf), the section and search a group run
 * gets (never the owner's private items), ranking that never sees a filtered-out item, explaining a tag, the owner's own person (one per
 * owner, backfilled once), and the vectors of the items (written after a write, backfilled at boot).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMemoryItems, type VisibleItem } from '@agent-desktop/memory-graph/memory';
import type { Store, ToolContext, WakeEvent } from '../../../contracts/index.js';
import { createMemoryStore } from '../../../testing/store.js';
import { profileIdFor } from '@agent-desktop/public-contracts';
import { groupNoteKey } from '../../groups/note.js';
import { createMemorySearchTool } from '../../tools/tools/memoryTools.js';
import { explainMemory } from '../explain.js';
import type { Embedder } from '../embedder.js';
import type { MemoryGraph } from '../graph.js';
import { presenceOf } from '../presence.js';
import { searchMemory } from '../search.js';
import { memorySectionFor } from '../section.js';
import { backfillOwnerPeople, ensureOwnerPerson } from '../owner.js';
import { backfillVectors, createVectorWriter } from '../vectors.js';
import { portOf, startMemoryGraph, type MemoryGraphFixture } from './memory-graph-fixture.js';

let graph: MemoryGraphFixture;

beforeAll(async () => {
  graph = await startMemoryGraph();
});

afterAll(async () => {
  await graph.close();
});

const fresh = (): string => 'owner-' + randomUUID();
/** The owner whose chats the tests below share. */
const OWNER = 'owner-shared-test';
const TELEGRAM = { kind: 'telegram', channelId: 'bot-1', chatId: '-100' };
const GROUP = groupNoteKey(OWNER, { ...TELEGRAM, workspace: '' });

/** A wake event as a run sees it: `origin` says who sent it. */
function wakeOf(originId: string, trusted: boolean): WakeEvent {
  return {
    id: 'wke-' + randomUUID(), ownerId: OWNER, agentId: 'agt-1', sessionKey: 'agt-1:c', conversationId: 'c', kind: 'user_message',
    origin: { type: 'user', id: originId }, trusted, priority: 'user', payload: { text: 'tea?' }, at: '2026-10-26T00:00:00.000Z', status: 'accepted',
  } as WakeEvent;
}

/** Conversations of one owner: the owner's app chat, a Telegram group with a stranger in it, and a stranger's direct chat. */
async function rooms(store: Store): Promise<void> {
  await store.put('agents', { id: 'agt-1', name: 'Juno', ownerId: OWNER, createdAt: '2026-10-01T00:00:00Z' } as never);
  await store.put('conversations', { id: 'c-app', kind: 'direct', agentIds: ['agt-1'], memberIds: [OWNER], ownerId: OWNER, createdAt: '2026-10-01T00:00:00Z' } as never);
  await store.put('conversations', { id: 'c-group', kind: 'room', title: 'Family', agentIds: ['agt-1'], memberIds: [OWNER, 'ext-alice'], ownerId: OWNER, channel: TELEGRAM, createdAt: '2026-10-01T00:00:00Z' } as never);
  await store.put('conversations', { id: 'c-stranger', kind: 'direct', agentIds: ['agt-1'], memberIds: ['ext-bob'], ownerId: OWNER, channel: { ...TELEGRAM, chatId: '999' }, createdAt: '2026-10-01T00:00:00Z' } as never);
}

describe('presenceOf', () => {
  it('is the owner in the owner\'s own chat, the group in a platform room, and anyone else otherwise', async () => {
    const store = createMemoryStore();
    await rooms(store);
    const run = (conversationId: string, wake: WakeEvent[]) => presenceOf(store, { ownerId: OWNER, agentId: 'agt-1', conversationId, wake });
    expect(await run('c-app', [wakeOf(OWNER, true)])).toEqual({ kind: 'owner' });
    expect(await run('c-group', [wakeOf('ext-alice', false)])).toEqual({ kind: 'group', groupKey: GROUP });
    expect(await run('c-stranger', [wakeOf('ext-bob', false)])).toEqual({ kind: 'other' });
    // The owner speaking in the group is still a group run: the others in the room read the replies.
    expect(await run('c-group', [wakeOf(OWNER, true)])).toEqual({ kind: 'group', groupKey: GROUP });
  });
});

describe('the memory a run reads', () => {
  it('a group run finds what the group said and public items, never the owner\'s, and the owner\'s own app run finds all of it', async () => {
    const owner = OWNER;
    const { items } = graph.graph;
    await items.addItem(owner, { text: 'Owner likes tea.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner' });
    await items.addItem(owner, { text: 'Family says tea is for Sundays.', kind: 'fact', file: 'memory', saidIn: 'group:' + GROUP, audience: 'group:' + GROUP });
    await items.addItem(owner, { text: 'Public tea facts.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'public' });
    const store = createMemoryStore();
    await rooms(store);
    const search = createMemorySearchTool({ memory: portOf(graph, store) });
    const ctx = (conversationId: string, wake: WakeEvent) => ({ store, ownerId: OWNER, agentId: 'agt-1', conversationId, wake } as unknown as ToolContext);

    const inGroup = await search.execute({ query: 'tea' }, ctx('c-group', wakeOf('ext-alice', false)));
    const groupText = inGroup.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    expect(groupText).toContain('Family says tea is for Sundays.');
    expect(groupText).toContain('Public tea facts.');
    expect(groupText).not.toContain('Owner likes tea.');

    const inApp = await search.execute({ query: 'tea' }, ctx('c-app', wakeOf(OWNER, true)));
    const appText = inApp.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    expect(appText).toContain('Owner likes tea.');
    expect(appText).toMatch(/\[mem:mem_[0-9a-f]{32}\]/);

    const stranger = await search.execute({ query: 'tea' }, ctx('c-stranger', wakeOf('ext-bob', false)));
    const strangerText = stranger.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    expect(strangerText).toContain('Public tea facts.');
    expect(strangerText).not.toContain('Family says');
    expect(strangerText).not.toContain('Owner likes tea.');
  });

  it('ranks only what the presence may see: the embedder is asked about the query alone, never about a filtered-out item', async () => {
    const owner = fresh();
    const { items } = graph.graph;
    const secret = await items.addItem(owner, { text: 'Secret roasting schedule for the owner.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner' });
    const shared = await items.addItem(owner, { text: 'Roasting marshmallows at the group camp.', kind: 'fact', file: 'memory', saidIn: 'group:' + GROUP, audience: 'group:' + GROUP });
    await items.setVector(owner, secret?.id ?? '', 'Secret roasting schedule for the owner.', { embedding: [1, 0], embedModel: 'm' });
    await items.setVector(owner, shared?.id ?? '', 'Roasting marshmallows at the group camp.', { embedding: [0, 1], embedModel: 'm' });
    const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => [1, 0]));
    const embedder = { model: 'm', embed } as Embedder;
    const memory: MemoryGraph = { items, identity: graph.graph.identity, relations: graph.graph.relations, embedder };

    const hits = await searchMemory(memory, { ownerId: owner, presence: { kind: 'group', groupKey: GROUP }, agentId: 'agt-1', query: 'roasting' });
    expect(hits.map((hit) => hit.item.text)).toEqual(['Roasting marshmallows at the group camp.']);
    expect(embed.mock.calls).toEqual([[['roasting']]]);
  });
});

describe('the memory section of a group run', () => {
  it('lists the group\'s items under the group heading, and not the owner\'s', async () => {
    const owner = fresh();
    const { items } = graph.graph;
    await items.addItem(owner, { text: 'Owner is allergic to peanuts.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner' });
    await items.addItem(owner, { text: 'We meet on Fridays.', kind: 'fact', file: 'memory', saidIn: 'group:' + GROUP, audience: 'group:' + GROUP });
    const store = createMemoryStore();
    const { section: text } = await memorySectionFor({ store, memory: graph.graph, ownerId: owner, agentId: 'agt-1', presence: { kind: 'group', groupKey: GROUP }, wake: [wakeOf('ext-alice', false)], canNote: true, people: [], runStart: true, delivered: new Set() });
    expect(text).toContain('## What this group has said (shared with everyone here)');
    expect(text).toContain('- We meet on Fridays. (said by someone in group chat)');
    expect(text).not.toContain('peanuts');
    expect(text).not.toContain('memory_note');
  });

  it('past 40 items the section text is the same whatever the wake says; the relevant items go to the run\'s note, once per session', async () => {
    const owner = fresh();
    const { items } = graph.graph;
    for (let i = 0; i < 45; i += 1) {
      await items.addItem(owner, { text: 'Fact number ' + String(i) + ' about the owner.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner', createdAt: '2026-01-01T00:00:' + String(10 + i) + 'Z' });
    }
    await items.addItem(owner, { text: 'Trains to Utrecht every Monday.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner', createdAt: '2025-06-01T00:00:00Z' });
    const store = createMemoryStore();
    const run = (text: string, delivered: Set<string>) => memorySectionFor({ store, memory: graph.graph, ownerId: owner, agentId: 'agt-1', presence: { kind: 'owner' }, wake: [{ ...wakeOf(owner, true), payload: { text } }], canNote: false, people: [], runStart: true, delivered });
    const first = await run('when do I go to Utrecht?', new Set());
    const second = await run('what should I cook tonight?', new Set());
    expect(second.section).toBe(first.section);
    expect(first.section).not.toContain('Trains to Utrecht');
    expect(first.relevant?.text).toContain('Trains to Utrecht every Monday.');
    expect(second.relevant?.text ?? '').not.toContain('Trains to Utrecht');
    // Already delivered in this session: not again.
    const again = await run('when do I go to Utrecht?', new Set(first.relevant?.ids ?? []));
    expect(again.relevant).toBeUndefined();
    // A build that is not the run's first adds no relevant block.
    const mid = await memorySectionFor({ store, memory: graph.graph, ownerId: owner, agentId: 'agt-1', presence: { kind: 'owner' }, wake: [wakeOf(owner, true)], canNote: false, people: [], runStart: false, delivered: new Set() });
    expect(mid.relevant).toBeUndefined();
  });
});

describe('memory_explain', () => {
  it('answers for what the presence may see, and says who may hear the rest', async () => {
    const owner = fresh();
    const { items } = graph.graph;
    const own = await items.addItem(owner, { text: 'Owner has a dog.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner' });
    const shared = await items.addItem(owner, { text: 'Group has a dog too.', kind: 'fact', file: 'memory', saidIn: 'group:' + GROUP, audience: 'group:' + GROUP });
    const store = createMemoryStore();
    const asGroup = await explainMemory(graph.graph, store, { ownerId: owner, presence: { kind: 'group', groupKey: GROUP }, agentId: 'agt-1', reference: { kind: 'mem', id: own?.id ?? '' } });
    expect(asGroup).toMatchObject({ kind: 'not_found' });
    const explained = await explainMemory(graph.graph, store, { ownerId: owner, presence: { kind: 'group', groupKey: GROUP }, agentId: 'agt-1', reference: { kind: 'mem', id: shared?.id ?? '' } });
    expect(explained).toMatchObject({ kind: 'item', saidBy: 'someone', place: 'a group chat', visibleTo: 'the people of group chat' });
    const asOwner = await explainMemory(graph.graph, store, { ownerId: owner, presence: { kind: 'owner' }, agentId: 'agt-1', reference: { kind: 'mem', id: own?.id ?? '' } });
    expect(asOwner).toMatchObject({ kind: 'item', place: 'the app', visibleTo: 'only the owner' });
  });
});

describe('the owner\'s own person', () => {
  it('is made from the profile name, once: a second backfill does nothing and ensuring again returns the same person', async () => {
    const owner = fresh();
    const store = createMemoryStore();
    await store.put('agents', { id: 'agt-1', name: 'Juno', ownerId: owner, createdAt: '2026-10-01T00:00:00Z' } as never);
    await store.put('profiles', { id: profileIdFor(owner), entries: [{ id: randomUUID(), key: 'Name', value: 'Robin', visibility: 'private', source: { by: 'user', at: '2026-10-01T00:00:00Z' } }], updatedAt: '2026-10-01T00:00:00Z' } as never);
    const memory = graph.graph;

    expect(await backfillOwnerPeople(store, memory)).toEqual({ skipped: false, owners: 1 });
    const people = await memory.identity.listPeople(owner);
    expect(people.filter((person) => person.isOwner)).toEqual([expect.objectContaining({ name: 'Robin', isOwner: true })]);
    expect(await backfillOwnerPeople(store, memory)).toEqual({ skipped: true, owners: 0 });
    expect(await memory.identity.listPeople(owner)).toHaveLength(people.length);
    expect((await ensureOwnerPerson(memory, store, owner)).id).toBe(people[0]?.id);
    expect((await memory.identity.listPeople(owner)).filter((person) => person.isOwner)).toHaveLength(1);
  });

  it('falls back to "Owner" when the owner has no profile name', async () => {
    const owner = fresh();
    const store = createMemoryStore();
    expect((await ensureOwnerPerson(graph.graph, store, owner)).name).toBe('Owner');
  });
});

describe('the vectors of the items', () => {
  it('embeds an item soon after it is written, and the backfill embeds the rest once', async () => {
    const owner = fresh();
    const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => [0.5, 0.5]));
    const embedder = { model: 'vec-test-' + randomUUID(), embed } as Embedder;
    const hook: { writer?: ReturnType<typeof createVectorWriter> } = {};
    const hooked = createMemoryItems(graph.db, { onWritten: (ownerId, id, text) => hook.writer?.onWritten(ownerId, id, text) });
    hook.writer = createVectorWriter({ items: hooked, embedder, delayMs: 1 });
    const written = await hooked.addItem(owner, { text: 'Likes cycling.', kind: 'preference', file: 'bank:preferences', saidIn: 'app', audience: 'owner' });
    await hook.writer.flush();
    const [stored] = await hooked.memoryFor(owner, { kind: 'owner' }, undefined, { vectors: true });
    expect(stored).toMatchObject({ id: written?.id, vector: { embedding: [0.5, 0.5], embedModel: embedder.model } });

    // An item written with no hook (before the writer existed) is found by the backfill, and is embedded once.
    const older = await graph.graph.items.addItem(owner, { text: 'Read the news at night.', kind: 'preference', file: 'bank:preferences', saidIn: 'app', audience: 'owner' });
    expect(await backfillVectors({ items: graph.graph.items, embedder })).toBeGreaterThan(0);
    const vectors = await graph.graph.items.memoryFor(owner, { kind: 'owner' }, undefined, { vectors: true });
    expect(vectors.find((item: VisibleItem) => item.id === older?.id)?.vector).toEqual({ embedding: [0.5, 0.5], embedModel: embedder.model });
    expect(await backfillVectors({ items: graph.graph.items, embedder })).toBe(0);
  });

  it('stores nothing when the embedder does not answer, and the items stay findable by words', async () => {
    const owner = fresh();
    const embedder = { model: 'down', embed: vi.fn(async () => null) } as Embedder;
    await graph.graph.items.addItem(owner, { text: 'Plays the cello.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner' });
    const hits = await searchMemory({ ...graph.graph, embedder }, { ownerId: owner, presence: { kind: 'owner' }, agentId: undefined, query: 'cello' });
    expect(hits.map((hit) => hit.item.text)).toEqual(['Plays the cello.']);
    expect(await backfillVectors({ items: graph.graph.items, embedder })).toBe(0);
  });
});

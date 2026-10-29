/**
 * The owner's People and Memory routes (BACKEND §10.17) over HTTP, with the memory port on a throwaway Postgres: another owner gets 404
 * for every id, link and unlink move accounts, an audience change shows to a stranger, the review queue keeps or deletes, and Today
 * caps what it lists.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import type { Today } from '@agent-desktop/public-contracts';
import { createIdentity } from '@agent-desktop/memory-graph/identity';
import { createMemoryItems } from '@agent-desktop/memory-graph/memory';
import { createRelations } from '@agent-desktop/memory-graph/relations';
import { startTestDatabase, type TestDatabase } from '@agent-desktop/memory-graph/testing';
import type { MemoryGraph } from 'juno-agent/modules/memory/graph';
import { createMemoryPort, type MemoryPort } from 'juno-agent/modules/memory/port';
import { createTestApp, requestAs } from '../../__tests__/test-app.js';

const noop = { enqueue: async () => ({ accepted: true }), stopRun: async () => {}, resolveAwakeable: async () => {}, scheduleRoutine: async () => {} };
const freshOwner = (): string => 'owner-own-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

let database: TestDatabase;
let graph: MemoryGraph;
let memory: MemoryPort;
let raw: ReturnType<typeof createMemoryStore>;
let app: Hono;

beforeAll(async () => {
  database = await startTestDatabase();
  graph = { items: createMemoryItems(database.db), identity: createIdentity(database.db), relations: createRelations(database.db) };
  raw = createMemoryStore();
  memory = createMemoryPort({ store: raw, graph });
  app = createTestApp({ store: raw as Store, bus: raw.eventBus, enqueuer: noop, memory, identity: graph.identity });
}, 240_000);

afterAll(async () => {
  await database?.close();
});

/** One request as `owner`, answered with the status and the parsed body. */
async function call(owner: string, path: string, method = 'GET', body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await requestAs(app, owner, path, { method, body });
  const text = await response.text();
  return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

const itemsOf = (json: Record<string, unknown>): Array<Record<string, unknown>> => (json['items'] as Array<Record<string, unknown>>) ?? [];
const texts = (items: ReadonlyArray<{ text: string }>): string[] => items.map((item) => item.text).sort();

describe('owner routes over HTTP', () => {
  it('another owner gets 404 for every id, and sees none of the owner\'s people, memory or relations', async () => {
    const me = freshOwner();
    const other = freshOwner();
    await memory.people.ensureOwner(me, 'Robin');
    const ana = await memory.people.createPerson(me, 'Ana');
    const ben = await memory.people.createPerson(me, 'Ben');
    const seen = await graph.identity.upsertAccount(me, { platform: 'telegram', externalId: 'ana-tg', name: 'Ana' }, { createPerson: false });
    const item = await memory.addItem(me, { text: 'Owner-only fact', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner', aboutPersonId: ana.id });
    const relation = await memory.relations.record(me, { a: ana.id, kind: 'friend', b: ben.id, evidence: { itemId: 'mem_x', quote: 'Ana and Ben are friends' }, confirmed: true });
    if (item === null || relation.outcome !== 'added') throw new Error('the seed was not written');

    expect(itemsOf((await call(other, '/v1/people')).json)).toEqual([]);
    expect(itemsOf((await call(other, '/v1/memory/items')).json)).toEqual([]);
    expect((await call(other, `/v1/people/${ana.id}`, 'PATCH', { name: 'Mallory' })).status).toBe(404);
    expect((await call(other, `/v1/people/${ana.id}/link`, 'POST', { accountId: seen.account.id })).status).toBe(404);
    expect((await call(other, `/v1/accounts/${seen.account.id}/unlink`, 'POST')).status).toBe(404);
    expect((await call(other, `/v1/relations/${relation.relation.id}/confirm`, 'POST')).status).toBe(404);
    expect((await call(other, `/v1/relations/${relation.relation.id}`, 'DELETE')).status).toBe(404);
    expect((await call(other, `/v1/memory/items/${item.id}`, 'PATCH', { text: 'Changed' })).status).toBe(404);
    expect((await call(other, `/v1/memory/items/${item.id}`, 'DELETE')).status).toBe(404);
    expect((await call(other, `/v1/memory/review/${item.id}`, 'POST', { action: 'delete' })).status).toBe(404);
    // The owner's own rows are untouched by those refusals.
    expect(texts(await memory.owner.items(me, {}))).toEqual(['Owner-only fact']);
    expect((await memory.owner.renamePerson(me, ana.id, 'Ana')).name).toBe('Ana');
  });

  it('link and unlink move an account; a name-alike account is a possible match until it is linked', async () => {
    const me = freshOwner();
    await memory.people.ensureOwner(me, 'Robin');
    const ana = await memory.people.createPerson(me, 'Ana');
    const seen = await graph.identity.upsertAccount(me, { platform: 'telegram', externalId: 'ana-tg', name: 'ana' }, { createPerson: false });

    const matches = itemsOf((await call(me, '/v1/people/possible-matches')).json);
    expect(matches.map((match) => match['person'])).toEqual([expect.objectContaining({ id: ana.id, name: 'Ana', isOwner: false })]);

    expect((await call(me, `/v1/people/${ana.id}/link`, 'POST', { accountId: seen.account.id })).status).toBe(200);
    expect(itemsOf((await call(me, '/v1/people/possible-matches')).json)).toEqual([]);
    const linked = itemsOf((await call(me, '/v1/people')).json).find((person) => person['id'] === ana.id);
    expect((linked?.['accounts'] as Array<{ id: string }>).map((account) => account.id)).toEqual([seen.account.id]);

    expect((await call(me, `/v1/accounts/${seen.account.id}/unlink`, 'POST')).status).toBe(200);
    // The person it left had nothing else, so it is dropped (as a link drops an empty person); the account is on a person of its own.
    const after = itemsOf((await call(me, '/v1/people')).json);
    expect(after.some((person) => person['id'] === ana.id)).toBe(false);
    const alone = after.find((person) => (person['accounts'] as Array<{ id: string }>).some((account) => account.id === seen.account.id));
    expect(alone).toMatchObject({ name: 'ana', isOwner: false });
    expect(itemsOf((await call(me, '/v1/people/possible-matches')).json)).toEqual([]);

    const renamed = await call(me, `/v1/people/${String(alone?.['id'])}`, 'PATCH', { name: 'Ana Lee' });
    expect(renamed.json).toMatchObject({ name: 'Ana Lee' });
    expect((await call(me, `/v1/people/${String(alone?.['id'])}`, 'PATCH', { name: '   ' })).status).toBe(400);
  });

  it('an audience change persists and shows to a stranger as it is; the list labels say where and to whom', async () => {
    const me = freshOwner();
    await memory.people.ensureOwner(me, 'Mint');
    const item = await memory.addItem(me, { text: 'Lives in Lisbon', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner' });
    if (item === null) throw new Error('the item was not written');
    expect(await memory.memoryFor(me, { kind: 'other' }, undefined)).toEqual([]);

    const widened = await call(me, `/v1/memory/items/${item.id}`, 'PATCH', { audience: 'public' });
    expect(widened.json).toMatchObject({ id: item.id, audience: { kind: 'public' }, saidIn: { label: 'Your chat' } });
    expect(texts(await memory.memoryFor(me, { kind: 'other' }, undefined))).toEqual(['Lives in Lisbon']);

    const narrowed = await call(me, `/v1/memory/items/${item.id}`, 'PATCH', { audience: 'owner', sensitive: true });
    expect(narrowed.json).toMatchObject({ audience: { kind: 'owner', label: 'Only you' }, sensitive: true });
    expect(await memory.memoryFor(me, { kind: 'other' }, undefined)).toEqual([]);

    expect((await call(me, `/v1/memory/items/${item.id}`, 'PATCH', {})).status).toBe(400);
    expect((await call(me, `/v1/memory/items/${item.id}`, 'PATCH', { audience: 'group' })).status).toBe(400);
  });

  it('review: the queue lists needs-review items; keep shows one (naming its person), delete removes one', async () => {
    const me = freshOwner();
    await memory.people.ensureOwner(me, 'Robin');
    const ana = await memory.people.createPerson(me, 'Ana');
    const keep = await memory.addItem(me, { text: 'Moved to Porto?', kind: 'fact', file: 'memory', saidIn: 'dm:telegram', audience: 'owner', status: 'needs_review' });
    const drop = await memory.addItem(me, { text: 'Wrong person', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner', status: 'needs_review' });
    if (keep === null || drop === null) throw new Error('the review items were not written');

    const queue = itemsOf((await call(me, '/v1/memory/review')).json);
    expect(queue.map((item) => item['id']).sort()).toEqual([keep.id, drop.id].sort());
    expect(queue.find((item) => item['id'] === keep.id)?.['saidIn']).toEqual({ label: 'Telegram DM' });

    expect((await call(me, `/v1/memory/review/${keep.id}`, 'POST', { action: 'keep', about: 'per_missing' })).status).toBe(400);
    const kept = await call(me, `/v1/memory/review/${keep.id}`, 'POST', { action: 'keep', about: ana.id });
    expect(kept.json).toMatchObject({ id: keep.id, status: 'active', about: { personId: ana.id, name: 'Ana' } });
    expect(texts(await memory.memoryFor(me, { kind: 'owner' }, undefined))).toEqual(['Moved to Porto?']);

    expect((await call(me, `/v1/memory/review/${drop.id}`, 'POST', { action: 'delete' })).status).toBe(200);
    expect(itemsOf((await call(me, '/v1/memory/review')).json)).toEqual([]);
    expect(itemsOf((await call(me, '/v1/memory/items')).json).map((item) => item['id'])).toEqual([keep.id]);
  });

  it('topics: items carry their topic (other until sorted), can be listed by it, and the sections come with their summary, label and count; another owner sees none', async () => {
    const me = freshOwner();
    await memory.people.ensureOwner(me, 'Robin');
    const base = { kind: 'fact' as const, file: 'memory' as const, saidIn: 'app', audience: 'owner' };
    const muscle = (await memory.addItem(me, { ...base, text: 'Wants to build muscle', topic: 'health' }))?.id ?? '';
    const sugar = (await memory.addItem(me, { ...base, text: 'Wants less sugar', topic: 'health' }))?.id ?? '';
    await memory.addItem(me, { ...base, text: 'Lives in Leiden' });
    await graph.items.putTopicSummary(me, 'health', `You're [[${muscle}|building muscle]] and [[${sugar}|cutting sugar]].`, '2026-10-26T01:00:00.000Z');

    const all = itemsOf((await call(me, '/v1/memory/items')).json);
    expect(all.map((item) => [item['text'], item['topic']]).sort()).toEqual([['Lives in Leiden', 'other'], ['Wants less sugar', 'health'], ['Wants to build muscle', 'health']]);
    expect(texts(itemsOf((await call(me, '/v1/memory/items?topic=health')).json) as Array<{ text: string }>)).toEqual(['Wants less sugar', 'Wants to build muscle']);
    expect(texts(itemsOf((await call(me, '/v1/memory/items?topic=other')).json) as Array<{ text: string }>)).toEqual(['Lives in Leiden']);
    expect((await call(me, '/v1/memory/items?topic=moods')).status).toBe(400);

    const topics = await call(me, '/v1/memory/topics');
    expect(topics.status).toBe(200);
    expect(itemsOf(topics.json)).toEqual([
      {
        topic: 'health', label: 'Health', summary: "You're building muscle and cutting sugar.", count: 2, updatedAt: '2026-10-26T01:00:00.000Z',
        segments: [{ text: "You're " }, { text: 'building muscle', itemId: muscle }, { text: ' and ' }, { text: 'cutting sugar', itemId: sugar }, { text: '.' }],
      },
      expect.objectContaining({ topic: 'other', label: 'Other', summary: '', segments: [], count: 1 }),
    ]);
    // An item that is no longer active stays in the sentence as plain text.
    await graph.items.retract(me, sugar);
    expect(itemsOf((await call(me, '/v1/memory/topics')).json)[0]).toMatchObject({
      summary: "You're building muscle and cutting sugar.", count: 1,
      segments: [{ text: "You're " }, { text: 'building muscle', itemId: muscle }, { text: ' and cutting sugar.' }],
    });
    expect(itemsOf((await call(freshOwner(), '/v1/memory/topics')).json)).toEqual([]);
  });

  it('quote: an item shows the person\'s own words and when; an agent\'s note, an agent message, a missing message and a changed message give null; long words are cut', async () => {
    const me = freshOwner();
    await memory.people.ensureOwner(me, 'Robin');
    const base = { kind: 'fact' as const, file: 'memory' as const, saidIn: 'app', audience: 'owner' };
    const at = '2026-10-20T08:30:00.000Z';
    const message = (id: string, doc: Record<string, unknown>) => raw.put('items', { id, ownerId: me, conversationId: 'cvn-' + id, at, ...doc } as never, { conversationId: 'cvn-' + id });
    const userSaid = (text: string) => ({ type: 'user_message', authorId: me, text, attachments: [], mentions: [] });
    const long = 'I have been training every morning before work for months now and '.repeat(6).trim();
    await message(`msg-said-${me}`, userSaid('I train four times a week, mostly mornings, and I want to cut sugar'));
    await message(`msg-long-${me}`, userSaid(long));
    await message(`msg-agent-${me}`, { type: 'agent_message', agentId: 'agt-1', markdown: 'You train four times a week', citations: [] });
    await message(`msg-edited-${me}`, userSaid('Something else entirely'));

    const withQuote = async (text: string, itemId: string, quote: string) => (await memory.addItem(me, { ...base, text, evidence: [{ itemId, quote }] }))?.id ?? '';
    const said = await withQuote('Trains four times a week', `msg-said-${me}`, 'I train four times a week');
    const cut = await withQuote('Trains every morning', `msg-long-${me}`, long);
    const agentSaid = await withQuote('Trains weekly', `msg-agent-${me}`, 'You train four times a week');
    const gone = await withQuote('Wants less sugar', `msg-erased-${me}`, 'I want to cut sugar');
    const edited = await withQuote('Likes tea', `msg-edited-${me}`, 'I like tea');
    const log = await withQuote('Reads at night', 'log:memory/2026-10-20.md', 'reads at night');
    const note = (await memory.addItem(me, { ...base, text: 'Seems to prefer short answers', saidByAgentId: 'agt-1' }))?.id ?? '';

    const items = itemsOf((await call(me, '/v1/memory/items')).json);
    const quoteOf = (id: string): unknown => items.find((item) => item['id'] === id)?.['quote'];
    expect(quoteOf(said)).toEqual({ text: 'I train four times a week', at });
    const trimmed = (quoteOf(cut) as { text: string; at: string }).text;
    expect(trimmed.length).toBeLessThanOrEqual(280);
    expect(trimmed.endsWith('…')).toBe(true);
    expect(long.startsWith(trimmed.slice(0, -1))).toBe(true);
    expect(long.slice(trimmed.length - 1)).toMatch(/^\s/);
    for (const id of [agentSaid, gone, edited, log, note]) expect(quoteOf(id)).toBeNull();

    // The edit route answers with the same view.
    const patched = await call(me, `/v1/memory/items/${said}`, 'PATCH', { sensitive: true });
    expect(patched.json['quote']).toEqual({ text: 'I train four times a week', at });
  });

  it('confirm and delete a relation: confirmed by the owner, then gone; deleting it again is not found', async () => {
    const me = freshOwner();
    const ana = await memory.people.createPerson(me, 'Ana');
    const ben = await memory.people.createPerson(me, 'Ben');
    await memory.relations.record(me, { a: ana.id, kind: 'friend', b: ben.id, evidence: { itemId: 'mem_y', quote: 'Ana and Ben are friends' }, confirmed: false });
    const [row] = await memory.relations.currentOf(me, ana.id);
    if (row === undefined) throw new Error('the relation was not recorded');
    expect((await call(me, `/v1/relations/${row.id}/confirm`, 'POST')).json).toEqual({ id: row.id, confirmed: true });
    expect((await call(me, `/v1/relations/${row.id}`, 'DELETE')).status).toBe(200);
    expect(await memory.relations.currentOf(me, ana.id)).toEqual([]);
    expect((await call(me, `/v1/relations/${row.id}`, 'DELETE')).status).toBe(404);
  });

  it('today: needs-you is capped at 10 with the total, the feed at 5, the open ideas at 3 and the goals at 5', async () => {
    const me = freshOwner();
    await memory.people.ensureOwner(me, 'Robin');
    for (let index = 0; index < 12; index += 1) {
      await memory.addItem(me, { text: `Review ${String(index)}`, kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner', status: 'needs_review' });
    }
    const stamp = (index: number): string => new Date(Date.UTC(2026, 9, 20, 9, index)).toISOString();
    for (let index = 0; index < 7; index += 1) {
      await raw.put('feedPosts', { id: `post-${String(index)}-${me}`, ownerId: me, agentId: 'agt-news', title: `Post ${String(index)}`, summary: 'Summary', liked: false, createdAt: stamp(index), updatedAt: stamp(index) } as never);
    }
    for (let index = 0; index < 5; index += 1) {
      await raw.put('ideas', { id: `idea-${String(index)}-${me}`, ownerId: me, agentId: 'agt-news', text: 'Try it', prompt: 'Try it', status: index === 4 ? 'dismissed' : 'open', createdAt: stamp(index), updatedAt: stamp(index) } as never);
    }
    for (let index = 0; index < 7; index += 1) {
      await raw.put('goals', { id: `goal-${String(index)}-${me}`, ownerId: me, agentId: 'agt-news', kind: 'goal', title: `Goal ${String(index)}`, summary: '', status: 'active', steps: [{ text: 'a', done: true }, { text: 'b', done: false }], createdAt: stamp(index), updatedAt: stamp(index) } as never);
    }

    const today = (await call(me, '/v1/today')).json as unknown as Today;
    expect(today.needsYou.total).toBe(12);
    expect(today.needsYou.items).toHaveLength(10);
    expect(today.needsYou.items.every((item) => item.kind === 'memory_review')).toBe(true);
    expect(today.feed).toHaveLength(5);
    expect(today.feed[0]?.title).toBe('Post 6');
    expect(today.ideas.map((idea) => idea.status)).toEqual(['open', 'open', 'open']);
    expect(today.progress.goals).toHaveLength(5);
    expect(today.progress.goals[0]).toMatchObject({ title: 'Goal 6', done: 1, total: 2 });
    expect(today.progress.working).toEqual(today.working);
  });
});

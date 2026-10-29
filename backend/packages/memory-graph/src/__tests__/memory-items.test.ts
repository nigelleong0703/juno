/**
 * The memory items on a real (embedded) Postgres: the labels round-trip, every method is confined to its owner, a legacy ref is taken
 * once, a person must belong to the same owner, and deleting a person keeps the item (it only loses who it is about).
 * Every owner id is unique per run, because the database keeps rows between runs.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DurableDb } from '@agent-desktop/durable';
import { createIdentity } from '../identity/index.js';
import { createMemoryItems, MemoryItemError, type MemoryItems } from '../memory/index.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';

let database: TestDatabase;
let db: DurableDb;
let items: MemoryItems;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.db;
  items = createMemoryItems(db);
});

afterAll(async () => {
  await database.close();
});

const freshOwner = (): string => 'owner-' + randomUUID();
const base = { kind: 'fact' as const, file: 'memory' as const, saidIn: 'app', audience: 'owner' };

describe('memory items', () => {
  it('keeps every label and reads an item back only under its own owner', async () => {
    const me = freshOwner();
    const other = freshOwner();
    const added = await items.addItem(me, { ...base, text: '  Lives in Leiden.  ', saidByAgentId: 'agt-1', evidence: [{ itemId: 'itm-1', quote: 'moved to Leiden' }] });
    expect(added).toMatchObject({ ownerId: me, text: 'Lives in Leiden.', kind: 'fact', file: 'memory', status: 'active', sensitive: false, aboutPersonId: null, agentId: null, saidByAgentId: 'agt-1', evidence: [{ itemId: 'itm-1', quote: 'moved to Leiden' }] });
    expect(added?.id).toMatch(/^mem_[0-9a-f]{32}$/);
    const id = added?.id ?? '';

    expect(await items.getItem(other, id)).toBeUndefined();
    expect(await items.listItems(other)).toEqual([]);
    await expect(items.updateItem(other, id, { text: 'stolen' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await items.deleteItem(other, id)).toBe(false);
    expect(await items.getItem(me, id)).toMatchObject({ text: 'Lives in Leiden.' });
  });

  it('changes only the given fields, retracts without deleting, and deletes for good', async () => {
    const me = freshOwner();
    const { id } = (await items.addItem(me, { ...base, text: 'Vegetarian.', file: 'bank:preferences', kind: 'preference' })) ?? { id: '' };
    const edited = await items.updateItem(me, id, { text: 'Eats no meat.', sensitive: true, evidence: null });
    expect(edited).toMatchObject({ text: 'Eats no meat.', kind: 'preference', file: 'bank:preferences', sensitive: true, evidence: null, status: 'active' });
    expect(edited.updatedAt >= edited.createdAt).toBe(true);

    expect(await items.retract(me, id)).toMatchObject({ status: 'retracted' });
    expect(await items.listItems(me, { status: 'active' })).toEqual([]);
    expect(await items.listItems(me, { status: 'retracted' })).toHaveLength(1);

    expect(await items.deleteItem(me, id)).toBe(true);
    expect(await items.getItem(me, id)).toBeUndefined();
    expect(await items.deleteItem(me, id)).toBe(false);
  });

  it('filters by file, status, agent, claim and the creation time', async () => {
    const me = freshOwner();
    const before = new Date().toISOString();
    await items.addItem(me, { ...base, text: 'A fact.', claimId: 'clm_one' });
    await items.addItem(me, { ...base, text: 'A circumstance.', file: 'bank:circumstances', kind: 'circumstance', agentId: 'agt-2', status: 'needs_review' });
    await items.addItem(me, { ...base, text: 'Old.', createdAt: '2020-01-01T00:00:00.000Z' });

    expect((await items.listItems(me, { file: 'bank:circumstances' })).map((item) => item.text)).toEqual(['A circumstance.']);
    expect((await items.listItems(me, { status: 'needs_review' })).map((item) => item.text)).toEqual(['A circumstance.']);
    expect((await items.listItems(me, { agentId: 'agt-2' })).map((item) => item.text)).toEqual(['A circumstance.']);
    expect((await items.listItems(me, { claimId: 'clm_one' })).map((item) => item.text)).toEqual(['A fact.']);
    expect((await items.listItems(me, { createdFrom: before })).map((item) => item.text).sort()).toEqual(['A circumstance.', 'A fact.']);
    const all = (await items.listItems(me)).map((item) => item.text);
    expect(all).toHaveLength(3);
    expect(all[0]).toBe('Old.');
  });

  it('takes a legacy ref once: the second add of the same migrated line is refused and the first is found by it', async () => {
    const me = freshOwner();
    const first = await items.addItem(me, { ...base, text: 'Moved to Leiden.', legacyRef: 'sha-line-1', saidIn: 'migrated' });
    expect(first).not.toBeNull();
    expect(await items.addItem(me, { ...base, text: 'Moved to Leiden.', legacyRef: 'sha-line-1', saidIn: 'migrated' })).toBeNull();
    expect(await items.findByLegacyRef(me, 'sha-line-1')).toMatchObject({ id: first?.id });
    expect(await items.findByLegacyRef(freshOwner(), 'sha-line-1')).toBeUndefined();
  });

  it('refuses bad input before it reaches the database', async () => {
    const me = freshOwner();
    await expect(items.addItem(me, { ...base, text: '   ' })).rejects.toBeInstanceOf(MemoryItemError);
    await expect(items.addItem(me, { ...base, text: 'x', kind: 'mood' as never })).rejects.toMatchObject({ code: 'invalid' });
    await expect(items.addItem(me, { ...base, text: 'x', file: 'people' as never })).rejects.toMatchObject({ code: 'invalid' });
    await expect(items.addItem('  ', { ...base, text: 'x' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(items.listItems('')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('names a person only of its own owner, and keeps the item when that person is removed', async () => {
    const me = freshOwner();
    const other = freshOwner();
    const alice = (await createIdentity(db).createPerson(me, 'Alice')).id;
    await expect(items.addItem(other, { ...base, text: 'Alice drinks tea.', file: 'person', aboutPersonId: alice })).rejects.toThrow();

    const about = await items.addItem(me, { ...base, text: 'Alice drinks tea.', file: 'person', aboutPersonId: alice });
    expect(about).toMatchObject({ aboutPersonId: alice });
    await db.query('DELETE FROM people WHERE owner_id = ? AND id = ?', [me, alice]);
    expect(await items.getItem(me, about?.id ?? '')).toMatchObject({ text: 'Alice drinks tea.', aboutPersonId: null });
  });

  it('keeps a topic (none until given), filters by it with other also matching the untopiced, and refuses a topic that is not on the list', async () => {
    const me = freshOwner();
    const none = await items.addItem(me, { ...base, text: 'Lives in Leiden.' });
    const health = await items.addItem(me, { ...base, text: 'Wants less sugar.', topic: 'health' });
    expect(none?.topic).toBeNull();
    expect(health?.topic).toBe('health');
    expect((await items.listItems(me, { topic: 'health' })).map((item) => item.text)).toEqual(['Wants less sugar.']);
    expect((await items.listItems(me, { topic: 'other' })).map((item) => item.text)).toEqual(['Lives in Leiden.']);
    expect(await items.updateItem(me, none?.id ?? '', { topic: 'home' })).toMatchObject({ topic: 'home' });
    expect(await items.updateItem(me, none?.id ?? '', { topic: null })).toMatchObject({ topic: null });
    await expect(items.addItem(me, { ...base, text: 'x', topic: 'mood' as never })).rejects.toMatchObject({ code: 'invalid' });
    await expect(items.updateItem(me, none?.id ?? '', { topic: 'mood' as never })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('stores one summary per topic and owner, replaces it, removes it, and never shows it to another owner', async () => {
    const me = freshOwner();
    const other = freshOwner();
    await items.putTopicSummary(me, 'health', "You're building muscle.", '2026-10-26T01:00:00.000Z');
    await items.putTopicSummary(me, 'work', 'You run a studio.');
    await items.putTopicSummary(me, 'health', "You're building muscle and cutting sugar.", '2026-10-26T02:00:00.000Z');
    expect(await items.listTopicSummaries(other)).toEqual([]);
    expect(await items.listTopicSummaries(me)).toEqual([
      { topic: 'health', summary: "You're building muscle and cutting sugar.", updatedAt: '2026-10-26T02:00:00.000Z' },
      expect.objectContaining({ topic: 'work', summary: 'You run a studio.' }),
    ]);
    await items.deleteTopicSummary(me, 'work');
    expect((await items.listTopicSummaries(me)).map((entry) => entry.topic)).toEqual(['health']);
    await expect(items.putTopicSummary(me, 'mood' as never, 'x')).rejects.toMatchObject({ code: 'invalid' });
  });
});

/**
 * What a presence may read (`memoryFor`) on a real (embedded) Postgres: the owner sees its active items except another agent's private
 * ones; a group sees its own unsensitive items and public unsensitive ones; anyone else sees public unsensitive ones only. Also the vectors
 * of the items and the write hook. Every owner id is unique per run, because the database keeps rows between runs.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DurableDb } from '@agent-desktop/durable';
import { createMemoryItems, type MemoryItems } from '../memory/index.js';
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

/** One item of each kind of label, all of one owner. */
async function seeded(owner: string) {
  const add = (text: string, over: Partial<typeof base> & { agentId?: string; sensitive?: boolean; status?: 'retracted' | 'needs_review' } = {}) =>
    items.addItem(owner, { ...base, text, ...over });
  await add('Owner app note.');
  await add('Owner sensitive note.', { sensitive: true });
  await add('Agent two private note.', { agentId: 'agt-2' });
  await add('Group one note.', { audience: 'group:G1', saidIn: 'group:G1' });
  await add('Group one secret.', { audience: 'group:G1', saidIn: 'group:G1', sensitive: true });
  await add('Group two note.', { audience: 'group:G2', saidIn: 'group:G2' });
  await add('Group one private to agent two.', { audience: 'group:G1', saidIn: 'group:G1', agentId: 'agt-2' });
  await add('Public fact.', { audience: 'public' });
  await add('Public secret.', { audience: 'public', sensitive: true });
  await add('Retracted note.', { status: 'retracted' });
  await add('Waiting for review.', { status: 'needs_review' });
}

const texts = async (owner: string, presence: Parameters<MemoryItems['memoryFor']>[1], agentId: string | undefined): Promise<string[]> =>
  (await items.memoryFor(owner, presence, agentId)).map((item) => item.text).sort();

describe('memoryFor: what each presence may read', () => {
  it('the owner reads every active item except another agent\'s private one (the app, with no agent, reads those too)', async () => {
    const owner = freshOwner();
    await seeded(owner);
    const owned = ['Group one note.', 'Group one secret.', 'Group two note.', 'Owner app note.', 'Owner sensitive note.', 'Public fact.', 'Public secret.'];
    expect(await texts(owner, { kind: 'owner' }, 'agt-1')).toEqual(owned);
    expect(await texts(owner, { kind: 'owner' }, 'agt-2')).toEqual([...owned, 'Agent two private note.', 'Group one private to agent two.'].sort());
    expect(await texts(owner, { kind: 'owner' }, undefined)).toEqual([...owned, 'Agent two private note.', 'Group one private to agent two.'].sort());
  });

  it('a group reads its own unsensitive items and the public unsensitive ones, and no one else\'s, nor another agent\'s private one', async () => {
    const owner = freshOwner();
    await seeded(owner);
    expect(await texts(owner, { kind: 'group', groupKey: 'G1' }, 'agt-1')).toEqual(['Group one note.', 'Public fact.']);
    expect(await texts(owner, { kind: 'group', groupKey: 'G1' }, 'agt-2')).toEqual(['Group one note.', 'Group one private to agent two.', 'Public fact.'].sort());
    expect(await texts(owner, { kind: 'group', groupKey: 'G2' }, 'agt-1')).toEqual(['Group two note.', 'Public fact.'].sort());
  });

  it('anyone else reads only the public unsensitive items', async () => {
    const owner = freshOwner();
    await seeded(owner);
    expect(await texts(owner, { kind: 'other' }, 'agt-1')).toEqual(['Public fact.']);
  });

  it('never reads another owner\'s items, retracted items, or items waiting for review', async () => {
    const owner = freshOwner();
    await seeded(owner);
    const everything = await Promise.all([{ kind: 'owner' as const }, { kind: 'group' as const, groupKey: 'G1' }, { kind: 'other' as const }].map((presence) => texts(owner, presence, undefined)));
    for (const list of everything) {
      expect(list).not.toContain('Retracted note.');
      expect(list).not.toContain('Waiting for review.');
    }
    expect(await texts(freshOwner(), { kind: 'owner' }, undefined)).toEqual([]);
  });
});

describe('vectors of the items', () => {
  it('reads a vector only when asked, stores it against the text it was made from, and clears it when the text changes', async () => {
    const owner = freshOwner();
    const { id } = (await items.addItem(owner, { ...base, text: 'Likes tea.' })) ?? { id: '' };
    expect(await items.memoryFor(owner, { kind: 'owner' }, undefined)).toEqual([expect.not.objectContaining({ vector: expect.anything() })]);
    const [plain] = await items.memoryFor(owner, { kind: 'owner' }, undefined, { vectors: true });
    expect(plain).toMatchObject({ id, vector: null });

    expect(await items.setVector(owner, id, 'Something else.', { embedding: [1, 0], embedModel: 'm1' })).toBe(false);
    expect(await items.setVector(owner, id, 'Likes tea.', { embedding: [1, 0], embedModel: 'm1' })).toBe(true);
    const [stored] = await items.memoryFor(owner, { kind: 'owner' }, undefined, { vectors: true });
    expect(stored?.vector).toEqual({ embedding: [1, 0], embedModel: 'm1' });

    await items.updateItem(owner, id, { text: 'Likes green tea.' });
    const [changed] = await items.memoryFor(owner, { kind: 'owner' }, undefined, { vectors: true });
    expect(changed?.vector).toBeNull();
  });

  it('lists the items without a vector of a model, not retracted ones, and the list shrinks as vectors are stored', async () => {
    const owner = freshOwner();
    const model = 'backfill-' + randomUUID();
    const kept = await items.addItem(owner, { ...base, text: 'Needs a vector.' });
    const gone = await items.addItem(owner, { ...base, text: 'Retracted, needs none.', status: 'retracted' });
    const mine = (await items.itemsNeedingVector(model, 1000)).filter((entry) => entry.ownerId === owner);
    expect(mine).toEqual([{ ownerId: owner, id: kept?.id ?? '', text: 'Needs a vector.' }]);
    expect(gone).not.toBeNull();
    await items.setVector(owner, kept?.id ?? '', 'Needs a vector.', { embedding: [0, 1], embedModel: model });
    expect((await items.itemsNeedingVector(model, 1000)).filter((entry) => entry.ownerId === owner)).toEqual([]);
  });
});

describe('the write hook', () => {
  it('is called with the owner, id and text of every new or reworded item, and not for the other writes', async () => {
    const owner = freshOwner();
    const onWritten = vi.fn();
    const hooked = createMemoryItems(db, { onWritten });
    const added = await hooked.addItem(owner, { ...base, text: '  Lives in Leiden. ' });
    expect(onWritten).toHaveBeenLastCalledWith(owner, added?.id ?? '', 'Lives in Leiden.');
    await hooked.updateItem(owner, added?.id ?? '', { status: 'retracted' });
    expect(onWritten).toHaveBeenCalledTimes(1);
    await hooked.updateItem(owner, added?.id ?? '', { text: 'Lives in Utrecht.' });
    expect(onWritten).toHaveBeenLastCalledWith(owner, added?.id ?? '', 'Lives in Utrecht.');
    expect(onWritten).toHaveBeenCalledTimes(2);
  });
});

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
  // These tests use two-number vectors; production aligns the column to its embedding model at boot.
  await items.alignVectorDimension(2);
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
  const ids = (hits: Array<{ id: string }>): string[] => hits.map((hit) => hit.id);

  it('stores a vector against the text it was made from, finds it by cosine, and clears it when the text changes', async () => {
    const owner = freshOwner();
    const { id } = (await items.addItem(owner, { ...base, text: 'Likes tea.' })) ?? { id: '' };
    const query = { embedding: [1, 0], embedModel: 'm1' };
    expect(await items.nearest(owner, { kind: 'owner' }, undefined, query, { limit: 5 })).toEqual([]);

    expect(await items.setVector(owner, id, 'Something else.', query)).toBe(false);
    expect(await items.setVector(owner, id, 'Likes tea.', query)).toBe(true);
    const [hit] = await items.nearest(owner, { kind: 'owner' }, undefined, query, { limit: 5 });
    expect(hit).toMatchObject({ id });
    expect(hit?.cosine).toBeCloseTo(1, 5);
    // A vector from another model is not compared.
    expect(await items.nearest(owner, { kind: 'owner' }, undefined, { ...query, embedModel: 'm2' }, { limit: 5 })).toEqual([]);

    await items.updateItem(owner, id, { text: 'Likes green tea.' });
    expect(await items.nearest(owner, { kind: 'owner' }, undefined, query, { limit: 5 })).toEqual([]);
  });

  it('orders by cosine, cuts at the limit, restricts to given ids, and sees only what the presence may read', async () => {
    const owner = freshOwner();
    const add = async (text: string, extra: Partial<Parameters<MemoryItems['addItem']>[1]>, embedding: number[]): Promise<string> => {
      const item = await items.addItem(owner, { ...base, text, ...extra });
      await items.setVector(owner, item?.id ?? '', text, { embedding, embedModel: 'rank' });
      return item?.id ?? '';
    };
    const close = await add('Close.', {}, [1, 0.1]);
    const middle = await add('Middle.', {}, [1, 1]);
    const far = await add('Far.', {}, [0.1, 1]);
    const otherAgents = await add('Private to agent B.', { agentId: 'agt-b' }, [0.9, 0.1]);
    const query = { embedding: [1, 0], embedModel: 'rank' };

    // Agent A does not see agent B's private item; the app (no agent) sees all.
    expect(ids(await items.nearest(owner, { kind: 'owner' }, 'agt-a', query, { limit: 10 }))).toEqual([close, middle, far]);
    expect(ids(await items.nearest(owner, { kind: 'owner' }, undefined, query, { limit: 10 }))).toEqual([close, otherAgents, middle, far]);
    expect(ids(await items.nearest(owner, { kind: 'owner' }, 'agt-a', query, { limit: 2 }))).toEqual([close, middle]);
    expect(ids(await items.nearest(owner, { kind: 'owner' }, 'agt-a', query, { limit: 10, ids: [far, middle, otherAgents] }))).toEqual([middle, far]);
    expect(await items.nearest(owner, { kind: 'owner' }, 'agt-a', query, { limit: 10, ids: [] })).toEqual([]);
    // A stranger reads only public unsensitive items: none here. Another owner reads nothing of this one.
    expect(await items.nearest(owner, { kind: 'other' }, undefined, query, { limit: 10 })).toEqual([]);
    expect(await items.nearest(freshOwner(), { kind: 'owner' }, undefined, query, { limit: 10 })).toEqual([]);
  });

  it('retypes the column for another model: the stored vectors are dropped to be embedded again', async () => {
    const owner = freshOwner();
    const item = await items.addItem(owner, { ...base, text: 'Has a vector.' });
    await items.setVector(owner, item?.id ?? '', 'Has a vector.', { embedding: [1, 0], embedModel: 'before' });
    expect(await items.alignVectorDimension(2)).toBe(false);
    try {
      expect(await items.alignVectorDimension(3)).toBe(true);
      expect(await items.nearest(owner, { kind: 'owner' }, undefined, { embedding: [1, 0, 0], embedModel: 'before' }, { limit: 5 })).toEqual([]);
      expect((await items.itemsNeedingVector('before', 1000)).map((entry) => entry.id)).toContain(item?.id);
      expect(await items.setVector(owner, item?.id ?? '', 'Has a vector.', { embedding: [0, 1, 0], embedModel: 'before' })).toBe(true);
    } finally {
      await items.alignVectorDimension(2);
    }
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

// People pages: the one-off move from people/<slug>.md to people/<personId>.md. Idempotent, and it waits for the identity graph.
import { describe, expect, it } from 'vitest';
import type { Identity, Person } from '@agent-desktop/memory-graph/identity';
import { createMemoryStore } from '../../../testing/store.js';
import { getRow, newRow, putRow, rowId } from '../../home/mirror.js';
import { listAll } from '../../memory/util.js';
import { migratePeoplePages, peoplePageList } from '../pages.js';

const AT = '2026-10-01T00:00:00.000Z';
const MARKER = '__migrations/people-pages-v1';
const SLUG_PAGE = '# Dr. Jan\n\n## Juno（agt-1）\n- Likes tea. [claim:clm_1]\n';

/** A people store in memory: createPerson counts what it made, so a rerun can be shown to make nothing. */
function fakeIdentity() {
  const people: Person[] = [];
  let made = 0;
  const identity = {
    async listPeople() {
      return people.slice();
    },
    async createPerson(ownerId: string, name: string) {
      made += 1;
      const person: Person = { id: 'per_' + String(made).padStart(32, '0'), ownerId, name, isOwner: false, createdAt: AT, updatedAt: AT };
      people.push(person);
      return person;
    },
  } as unknown as Identity;
  return { identity, created: () => made };
}

async function seed() {
  const store = createMemoryStore();
  await putRow(store, newRow('owner', 'people/dr-jan.md', SLUG_PAGE, 'platform', AT));
  await store.put('memoryClaims', { id: 'clm_1', ownerId: 'owner', text: 'Likes tea.', evidence: [], confidence: 0.9, status: 'active', target: { path: 'people/dr-jan.md', line: 3 }, createdAt: AT, updatedAt: AT } as never);
  return store;
}

describe('people pages', () => {
  it('moves a slug page to the person\'s id, named by its heading, and repoints the claims that cited it', async () => {
    const store = await seed();
    const { identity, created } = fakeIdentity();
    expect(await migratePeoplePages({ store, identity })).toEqual({ skipped: false, moved: 1 });
    expect(created()).toBe(1);
    const id = 'per_' + '0'.repeat(31) + '1';
    expect(await getRow(store, 'owner', 'people/dr-jan.md')).toBeNull();
    expect((await getRow(store, 'owner', 'people/' + id + '.md'))?.content).toBe(SLUG_PAGE);
    const claim = (await listAll(store, 'memoryClaims')).find((row) => row.id === 'clm_1');
    expect(claim?.target).toEqual({ path: 'people/' + id + '.md', line: 3 });
    expect(await peoplePageList(store, 'owner')).toEqual([{ id, name: 'Dr. Jan' }]);
  });

  it('is idempotent: a later boot skips it, and a rerun with the marker removed moves and makes nothing', async () => {
    const store = await seed();
    const { identity, created } = fakeIdentity();
    await migratePeoplePages({ store, identity });
    expect(await migratePeoplePages({ store, identity })).toEqual({ skipped: true, moved: 0 });
    await store.delete('agentHome', rowId('system', MARKER));
    expect(await migratePeoplePages({ store, identity })).toEqual({ skipped: false, moved: 0 });
    expect(created()).toBe(1);
  });

  it('waits for the identity graph: without it nothing moves and no marker is written', async () => {
    const store = await seed();
    expect(await migratePeoplePages({ store })).toEqual({ skipped: true, moved: 0 });
    expect(await getRow(store, 'owner', 'people/dr-jan.md')).not.toBeNull();
    expect(await getRow(store, 'system', MARKER)).toBeNull();
    const { identity } = fakeIdentity();
    expect(await migratePeoplePages({ store, identity })).toEqual({ skipped: false, moved: 1 });
  });
});

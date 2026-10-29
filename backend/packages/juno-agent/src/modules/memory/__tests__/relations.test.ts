/**
 * The digest's relations (BACKEND §9.6) on the embedded Postgres: each quote is checked against its message, both names resolve to people
 * (only the owner's word makes a person), a name matching nobody or several people drops the relation, and the owner's word is confirmed
 * while anyone else's is not. "owner" names the owner whoever speaks; "I" and "me" name the speaker.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Person } from '@agent-desktop/memory-graph/identity';
import type { ClaimsContext } from '../jobs/claims.js';
import type { SourceItem } from '../jobs/gather.js';
import type { JobDeps } from '../jobs/types.js';
import { applyRelations, resolveName, type Speaker } from '../relations.js';
import { startMemoryGraph, type MemoryGraphFixture } from './memory-graph-fixture.js';

let graph: MemoryGraphFixture;

beforeAll(async () => {
  graph = await startMemoryGraph();
}, 240_000);

afterAll(async () => {
  await graph?.close();
});

const AT = '2026-10-26T10:00:00.000Z';
const owner = (name: string): string => `${name}-${randomUUID().slice(0, 8)}`;
const OWNER_SPEAKER: Speaker = { ownerWord: true, personId: 'per_owner', ownerPersonId: 'per_owner' };
const OTHER_SPEAKER: Speaker = { ownerWord: false, personId: null, ownerPersonId: 'per_owner' };

describe('resolveName', () => {
  const known = [{ id: 'per_aaaa1111', name: 'Priya' }, { id: 'per_bbbb2222', name: 'Sam' }, { id: 'per_cccc3333', name: 'Sam' }];

  it('matches one person by exact name (any case) or by id', () => {
    expect(resolveName('priya', known, OWNER_SPEAKER)).toEqual({ kind: 'person', personId: 'per_aaaa1111' });
    expect(resolveName('per_aaaa', known, OWNER_SPEAKER)).toEqual({ kind: 'person', personId: 'per_aaaa1111' });
  });

  it('drops a name that several people share, instead of guessing', () => {
    expect(resolveName('Sam', known, OWNER_SPEAKER)).toEqual({ kind: 'missing', reason: 'more than one person is called Sam' });
  });

  it('makes a person only for the owner\'s own word, and never from an id', () => {
    expect(resolveName('Tom', known, OWNER_SPEAKER)).toEqual({ kind: 'create', name: 'Tom' });
    expect(resolveName('Tom', known, OTHER_SPEAKER)).toEqual({ kind: 'missing', reason: 'no person is called Tom' });
    expect(resolveName('per_zzzz9999', known, OWNER_SPEAKER)).toEqual({ kind: 'missing', reason: 'no person is called per_zzzz9999' });
  });

  it('reads "owner" as the owner whoever speaks, and "I" or "me" as the speaker', () => {
    expect(resolveName('owner', known, OTHER_SPEAKER)).toEqual({ kind: 'person', personId: 'per_owner' });
    expect(resolveName('me', known, OWNER_SPEAKER)).toEqual({ kind: 'person', personId: 'per_owner' });
    expect(resolveName('I', known, { ownerWord: false, personId: 'per_aaaa1111', ownerPersonId: 'per_owner' })).toEqual({ kind: 'person', personId: 'per_aaaa1111' });
    expect(resolveName('me', known, OTHER_SPEAKER)).toEqual({ kind: 'missing', reason: 'me is not a person yet' });
  });

  it('matches "Priya\'s" and "Priya’s" to Priya, and creates a new person plainly named, never with the possessive', () => {
    expect(resolveName("Priya's", known, OWNER_SPEAKER)).toEqual({ kind: 'person', personId: 'per_aaaa1111' });
    expect(resolveName('Priya’s', known, OWNER_SPEAKER)).toEqual({ kind: 'person', personId: 'per_aaaa1111' });
    expect(resolveName("Zed's", known, OWNER_SPEAKER)).toEqual({ kind: 'create', name: 'Zed' });
  });
});

describe('applyRelations', () => {
  /** A digest context over the given people, with the sender lookup the ingress would have made (message id -> person / account). */
  function contextOf(list: Person[], ownerPersonId: string | null, personOf: Array<[string, string]> = []): ClaimsContext {
    return {
      active: [],
      retracted: [],
      knownPeople: list.map((row) => ({ id: row.id, name: row.name })),
      ownerPersonId,
      senders: { labels: new Map(), personOf: new Map(personOf), senderOf: new Map() },
      agents: [],
    };
  }

  const deps = (): JobDeps => ({ memory: graph.graph, log: () => undefined }) as unknown as JobDeps;
  const message = (id: string, role: SourceItem['role'], text: string): SourceItem => ({ id, conversationId: 'conv-1', at: AT, role, text });

  it('records the owner\'s word as confirmed, and makes the person the owner names first', async () => {
    const ownerId = owner('word');
    const robin = await graph.graph.identity.ensureOwner(ownerId, 'Robin');
    const priya = await graph.graph.identity.createPerson(ownerId, 'Priya');
    const items = [message('m1', 'user', "Tom is Priya's manager, so loop him in on the release.")];
    const context = contextOf(await graph.graph.identity.listPeople(ownerId), robin.id);
    const result = await applyRelations(deps(), { ownerId, items, relations: [{ a: 'Tom', kind: 'manager_of', b: 'Priya', itemId: 'm1', quote: "Tom is Priya's manager" }], context });
    expect(result.accepted).toBe(1);
    expect((await graph.graph.identity.listPeople(ownerId)).map((row) => row.name)).toContain('Tom');
    const [row] = await graph.graph.relations.currentOf(ownerId, priya.id);
    expect(row?.personAName).toBe('Tom');
    expect(row?.kind).toBe('manager_of');
    expect(row?.confirmed).toBe(true);
    expect(row?.saidByPersonId).toBe(robin.id);
    expect(row?.evidence).toEqual({ itemId: 'm1', quote: "Tom is Priya's manager" });
  });

  it('reads "me" in the owner\'s message as the owner, and inverse wording the right way round', async () => {
    const ownerId = owner('inverse');
    const robin = await graph.graph.identity.ensureOwner(ownerId, 'Robin');
    const items = [message('m2', 'user', 'Priya reports to me on the platform team.')];
    const context = contextOf(await graph.graph.identity.listPeople(ownerId), robin.id);
    const result = await applyRelations(deps(), { ownerId, items, relations: [{ a: 'Priya', kind: 'reports_to', b: 'me', itemId: 'm2', quote: 'Priya reports to me' }], context });
    expect(result.accepted).toBe(1);
    const [row] = await graph.graph.relations.currentOf(ownerId, robin.id);
    expect(row?.kind).toBe('manager_of');
    expect(row?.personAName).toBe('Robin');
    expect(row?.personBName).toBe('Priya');
  });

  it('drops a relation whose quote is not in the cited message, and makes no person for it', async () => {
    const ownerId = owner('quote');
    const robin = await graph.graph.identity.ensureOwner(ownerId, 'Robin');
    await graph.graph.identity.createPerson(ownerId, 'Priya');
    const before = (await graph.graph.identity.listPeople(ownerId)).length;
    const items = [message('m3', 'user', 'Priya is busy this week.')];
    const context = contextOf(await graph.graph.identity.listPeople(ownerId), robin.id);
    const result = await applyRelations(deps(), { ownerId, items, relations: [{ a: 'Zed', kind: 'manager_of', b: 'Priya', itemId: 'm3', quote: 'Zed manages Priya' }], context });
    expect(result.accepted).toBe(0);
    expect(result.lines.join('\n')).toContain('the quote is not in its message');
    expect((await graph.graph.identity.listPeople(ownerId)).length).toBe(before);
  });

  it('never takes a quote from the assistant\'s own text', async () => {
    const ownerId = owner('assistant');
    const robin = await graph.graph.identity.ensureOwner(ownerId, 'Robin');
    await graph.graph.identity.createPerson(ownerId, 'Priya');
    const items = [message('m4', 'agent', "Tom is Priya's manager.")];
    const context = contextOf(await graph.graph.identity.listPeople(ownerId), robin.id);
    const result = await applyRelations(deps(), { ownerId, items, relations: [{ a: 'Tom', kind: 'manager_of', b: 'Priya', itemId: 'm4', quote: "Tom is Priya's manager" }], context });
    expect(result.accepted).toBe(0);
  });

  it('records someone else\'s statement about themselves as not confirmed, with them as the speaker', async () => {
    const ownerId = owner('other');
    const robin = await graph.graph.identity.ensureOwner(ownerId, 'Robin');
    const lee = await graph.graph.identity.createPerson(ownerId, 'Lee');
    const priya = await graph.graph.identity.createPerson(ownerId, 'Priya');
    const items = [message('m5', 'other', "I am Priya's brother.")];
    const context = contextOf(await graph.graph.identity.listPeople(ownerId), robin.id, [['m5', lee.id]]);
    const result = await applyRelations(deps(), { ownerId, items, relations: [{ a: 'I', kind: 'sibling', b: 'Priya', itemId: 'm5', quote: "I am Priya's brother" }], context });
    expect(result.accepted).toBe(1);
    const [row] = await graph.graph.relations.currentOf(ownerId, priya.id);
    expect(row?.confirmed).toBe(false);
    expect(row?.saidByPersonId).toBe(lee.id);
    // A sibling relation is stored once in canonical order, so the names are compared as a pair.
    expect([row?.personAName, row?.personBName].sort()).toEqual(['Lee', 'Priya']);
  });

  it('drops someone else\'s statement that names a person nobody knows, and makes no person for it', async () => {
    const ownerId = owner('stranger');
    const robin = await graph.graph.identity.ensureOwner(ownerId, 'Robin');
    const lee = await graph.graph.identity.createPerson(ownerId, 'Lee');
    await graph.graph.identity.createPerson(ownerId, 'Priya');
    const before = (await graph.graph.identity.listPeople(ownerId)).length;
    const items = [message('m6', 'other', "Zed is Priya's friend.")];
    const context = contextOf(await graph.graph.identity.listPeople(ownerId), robin.id, [['m6', lee.id]]);
    const result = await applyRelations(deps(), { ownerId, items, relations: [{ a: 'Zed', kind: 'friend', b: 'Priya', itemId: 'm6', quote: "Zed is Priya's friend" }], context });
    expect(result.accepted).toBe(0);
    expect(result.lines.join('\n')).toContain('no person is called Zed');
    expect((await graph.graph.identity.listPeople(ownerId)).length).toBe(before);
  });

  it('drops a relation whose name matches more than one person, and one person on both ends', async () => {
    const ownerId = owner('ambiguous');
    const robin = await graph.graph.identity.ensureOwner(ownerId, 'Robin');
    await graph.graph.identity.createPerson(ownerId, 'Sam');
    await graph.graph.identity.createPerson(ownerId, 'Sam');
    await graph.graph.identity.createPerson(ownerId, 'Priya');
    const items = [message('m7', 'user', "Sam is Priya's friend, and Priya is Priya.")];
    const context = contextOf(await graph.graph.identity.listPeople(ownerId), robin.id);
    const result = await applyRelations(deps(), {
      ownerId, items, context,
      relations: [
        { a: 'Sam', kind: 'friend', b: 'Priya', itemId: 'm7', quote: "Sam is Priya's friend" },
        { a: 'Priya', kind: 'friend', b: 'Priya', itemId: 'm7', quote: 'Priya is Priya' },
      ],
    });
    expect(result.accepted).toBe(0);
    expect(result.lines.join('\n')).toContain('more than one person is called Sam');
    expect(result.lines.join('\n')).toContain('a relation needs two different people');
  });

  it('keeps a malformed relation out without stopping the rest', async () => {
    const ownerId = owner('malformed');
    const robin = await graph.graph.identity.ensureOwner(ownerId, 'Robin');
    const priya = await graph.graph.identity.createPerson(ownerId, 'Priya');
    await graph.graph.identity.createPerson(ownerId, 'Tom');
    const items = [message('m8', 'user', 'Tom and Priya are friends.')];
    const context = contextOf(await graph.graph.identity.listPeople(ownerId), robin.id);
    const result = await applyRelations(deps(), {
      ownerId, items, context,
      relations: [{ a: 'Tom' }, { a: 'Tom', kind: 'friend', b: 'Priya', itemId: 'm8', quote: 'Tom and Priya are friends' }],
    });
    expect(result.accepted).toBe(1);
    expect(result.lines[0]).toBe('Rejected a relation: malformed');
    expect((await graph.graph.relations.currentOf(ownerId, priya.id)).length).toBe(1);
  });
});

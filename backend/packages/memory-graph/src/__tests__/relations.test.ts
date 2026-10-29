/**
 * Relations on a real (embedded) Postgres: a statement is kept once, an exclusive kind's newer statement closes the older one (its row
 * stays with a valid_to), an unconfirmed statement never replaces what the owner confirmed, owners are isolated, and a person with a
 * relation is not deleted when their last account moves. Every owner id is unique per run, because the database keeps rows between runs.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DurableDb } from '@agent-desktop/durable';
import { createIdentity, type Identity } from '../identity/index.js';
import { createRelations, RelationError, type RecordOutcome, type RecordRelation, type Relations } from '../relations/index.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';

let database: TestDatabase;
let db: DurableDb;
let identity: Identity;
let relations: Relations;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.db;
  identity = createIdentity(db);
  relations = createRelations(db);
}, 240_000);

afterAll(async () => {
  await database?.close();
});

const owner = (name: string): string => `${name}-${randomUUID().slice(0, 8)}`;
const EVIDENCE = { itemId: 'msg-1', quote: 'a quote from the message' };

/** A person of the owner, by name. */
async function person(ownerId: string, name: string): Promise<string> {
  return (await identity.createPerson(ownerId, name)).id;
}

function statement(ownerId: string, input: Pick<RecordRelation, 'a' | 'kind' | 'b'> & Partial<RecordRelation>): Promise<RecordOutcome> {
  return relations.record(ownerId, { evidence: EVIDENCE, confirmed: true, ...input });
}

/** The raw rows that name a person on either side, for the history (closed rows included). */
async function rowsOf(ownerId: string, personId: string): Promise<Array<{ person_a: string; valid_to: unknown }>> {
  return db.query(`SELECT person_a, valid_to FROM relations WHERE owner_id = ? AND (person_a = ? OR person_b = ?)`, [ownerId, personId, personId]);
}

describe('relations: recording', () => {
  it('keeps one statement once: saying it again changes nothing', async () => {
    const ownerId = owner('once');
    const tom = await person(ownerId, 'Tom');
    const priya = await person(ownerId, 'Priya');
    expect((await statement(ownerId, { a: tom, kind: 'manager_of', b: priya })).outcome).toBe('added');
    expect((await statement(ownerId, { a: tom, kind: 'manager_of', b: priya })).outcome).toBe('already');
    expect((await relations.listCurrent(ownerId)).length).toBe(1);
  });

  it('stores a symmetric kind once, whichever way round it is said', async () => {
    const ownerId = owner('friends');
    const anna = await person(ownerId, 'Anna');
    const priya = await person(ownerId, 'Priya');
    expect((await statement(ownerId, { a: priya, kind: 'friend', b: anna })).outcome).toBe('added');
    expect((await statement(ownerId, { a: anna, kind: 'friend', b: priya })).outcome).toBe('already');
    const rows = await relations.listCurrent(ownerId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.personA < rows[0]!.personB).toBe(true);
  });

  it('keeps the wording of an other relation as its label, with both names', async () => {
    const ownerId = owner('label');
    const sam = await person(ownerId, 'Sam');
    const priya = await person(ownerId, 'Priya');
    await statement(ownerId, { a: sam, kind: 'other', b: priya, kindLabel: 'mentor' });
    const [row] = await relations.currentOf(ownerId, priya);
    expect(row?.kind).toBe('other');
    expect(row?.kindLabel).toBe('mentor');
    expect(row?.personAName).toBe('Sam');
    expect(row?.personBName).toBe('Priya');
  });

  it('records who said it and the quote it rests on', async () => {
    const ownerId = owner('who');
    const priya = await person(ownerId, 'Priya');
    const lee = await person(ownerId, 'Lee');
    await statement(ownerId, { a: priya, kind: 'sibling', b: lee, confirmed: false, saidByPersonId: priya, evidence: { itemId: 'msg-9', quote: 'my brother Lee' } });
    const [row] = await relations.currentOf(ownerId, lee);
    expect(row?.confirmed).toBe(false);
    expect(row?.saidByName).toBe('Priya');
    expect(row?.evidence).toEqual({ itemId: 'msg-9', quote: 'my brother Lee' });
  });

  it('refuses a relation that names a person of another owner, and one person on both ends', async () => {
    const mine = owner('mine');
    const theirs = owner('theirs');
    const mineTom = await person(mine, 'Tom');
    const theirPriya = await person(theirs, 'Priya');
    await expect(statement(mine, { a: mineTom, kind: 'friend', b: theirPriya })).rejects.toMatchObject({ code: 'not_found' });
    await expect(statement(mine, { a: mineTom, kind: 'friend', b: mineTom })).rejects.toBeInstanceOf(RelationError);
  });
});

describe('relations: closing and trust', () => {
  it('a newer manager of the same person closes the older one, and the history stays', async () => {
    const ownerId = owner('manager');
    const tom = await person(ownerId, 'Tom');
    const sam = await person(ownerId, 'Sam');
    const priya = await person(ownerId, 'Priya');
    const old = await statement(ownerId, { a: tom, kind: 'manager_of', b: priya, confirmed: false });
    const now = await statement(ownerId, { a: sam, kind: 'manager_of', b: priya, confirmed: true, at: '2026-10-27T00:00:00.000Z' });
    if (old.outcome !== 'added' || now.outcome !== 'added') throw new Error('both statements should be recorded');
    expect(now.closed).toEqual([old.relation.id]);
    expect((await relations.currentOf(ownerId, priya)).map((row) => row.personAName)).toEqual(['Sam']);
    const history = await rowsOf(ownerId, priya);
    expect(history.length).toBe(2);
    expect(history.find((row) => row.person_a === tom)?.valid_to).not.toBeNull();
    expect(history.find((row) => row.person_a === sam)?.valid_to).toBeNull();
  });

  it('an unconfirmed statement cannot replace what the owner confirmed: it is refused and nothing closes', async () => {
    const ownerId = owner('refuse');
    const sam = await person(ownerId, 'Sam');
    const tom = await person(ownerId, 'Tom');
    const priya = await person(ownerId, 'Priya');
    await statement(ownerId, { a: sam, kind: 'manager_of', b: priya, confirmed: true });
    const attempt = await statement(ownerId, { a: tom, kind: 'manager_of', b: priya, confirmed: false });
    expect(attempt.outcome).toBe('refused');
    expect((await relations.currentOf(ownerId, priya)).map((row) => row.personAName)).toEqual(['Sam']);
  });

  it('the owner\'s confirmation upgrades an open unconfirmed statement in place', async () => {
    const ownerId = owner('upgrade');
    const tom = await person(ownerId, 'Tom');
    const priya = await person(ownerId, 'Priya');
    await statement(ownerId, { a: tom, kind: 'manager_of', b: priya, confirmed: false });
    expect((await statement(ownerId, { a: tom, kind: 'manager_of', b: priya, confirmed: true })).outcome).toBe('already');
    expect((await relations.currentOf(ownerId, priya))[0]?.confirmed).toBe(true);
    expect((await relations.listCurrent(ownerId)).length).toBe(1);
  });

  it('a new employer closes the old one of the same employee, and not another employee\'s', async () => {
    const ownerId = owner('employer');
    const priya = await person(ownerId, 'Priya');
    const lee = await person(ownerId, 'Lee');
    const acme = await person(ownerId, 'Acme');
    const beta = await person(ownerId, 'Beta');
    await statement(ownerId, { a: priya, kind: 'works_at', b: acme });
    await statement(ownerId, { a: lee, kind: 'works_at', b: acme });
    const moved = await statement(ownerId, { a: priya, kind: 'works_at', b: beta });
    expect(moved.outcome === 'added' ? moved.closed.length : -1).toBe(1);
    expect((await relations.currentOf(ownerId, priya)).map((row) => row.personBName)).toEqual(['Beta']);
    expect((await relations.currentOf(ownerId, lee)).map((row) => row.personBName)).toEqual(['Acme']);
  });
});

describe('relations: owners and people', () => {
  it('one owner never reads another owner\'s relations', async () => {
    const alice = owner('alice');
    const bob = owner('bob');
    const alicePriya = await person(alice, 'Priya');
    const aliceTom = await person(alice, 'Tom');
    await statement(alice, { a: aliceTom, kind: 'friend', b: alicePriya });
    expect(await relations.listCurrent(bob)).toEqual([]);
    expect(await relations.currentOf(bob, alicePriya)).toEqual([]);
  });

  it('a person with a relation is kept when their last account moves away; one without goes as before', async () => {
    const ownerId = owner('keep');
    const plain = await identity.upsertAccount(ownerId, { platform: 'telegram', externalId: 'plain-1', name: 'Plain' }, { createPerson: true });
    const kept = await identity.upsertAccount(ownerId, { platform: 'telegram', externalId: 'kept-1', name: 'Kept' }, { createPerson: true });
    const target = await person(ownerId, 'Target');
    const friend = await person(ownerId, 'Friend');
    await statement(ownerId, { a: kept.person!.id, kind: 'friend', b: friend });
    await identity.linkAccount(ownerId, plain.account.id, target);
    await identity.linkAccount(ownerId, kept.account.id, target);
    const ids = (await identity.listPeople(ownerId)).map((row) => row.id);
    expect(ids).not.toContain(plain.person!.id);
    expect(ids).toContain(kept.person!.id);
  });
});

/**
 * The identity graph on a real (embedded) Postgres: owner isolation, a sighting creates its person once (only when asked to), linking
 * moves an account and drops an empty person (never the owner), and the database refuses what the service must not write.
 * Every owner id is unique per run, because the database keeps rows between runs.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DurableDb } from '@agent-desktop/durable';
import { createIdentity, type Identity } from '../identity/index.js';
import { seedPeople, startTestDatabase, type TestDatabase } from '../testing/index.js';

let database: TestDatabase;
let db: DurableDb;
let identity: Identity;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.db;
  identity = createIdentity(db);
}, 240_000);

afterAll(async () => {
  await database?.close();
});

const owner = (name: string): string => `${name}-${randomUUID().slice(0, 8)}`;
const PERSON = { createPerson: true } as const;
const NO_PERSON = { createPerson: false } as const;

async function rowCounts(ownerId: string): Promise<{ people: number; accounts: number }> {
  const [row] = await db.query<{ people: string | number; accounts: string | number }>(
    `SELECT (SELECT COUNT(*) FROM people WHERE owner_id = ?) AS people, (SELECT COUNT(*) FROM accounts WHERE owner_id = ?) AS accounts`,
    [ownerId, ownerId],
  );
  return { people: Number(row?.people ?? 0), accounts: Number(row?.accounts ?? 0) };
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('identity graph (Postgres)', () => {
  it('refuses another owner\'s accounts and people, and an empty owner id', async () => {
    const [a, b] = [owner('alice'), owner('bob')];
    const alice = await seedPeople(db, a, { contacts: [{ name: 'Priya', accounts: [{ platform: 'telegram', externalId: `tg-${a}` }] }] });
    const bob = await seedPeople(db, b, { contacts: [{ name: 'Sam', accounts: [{ platform: 'telegram', externalId: `tg-${b}` }] }] });
    const priya = alice.contacts[0]!;
    const samAccount = bob.contacts[0]!.accounts[0]!;

    await rejectsWith(identity.resolve(b, priya.accounts[0]!.id), 'not_found');
    await rejectsWith(identity.linkAccount(b, samAccount.id, priya.person.id), 'not_found');
    await rejectsWith(identity.linkAccount(b, priya.accounts[0]!.id, bob.owner.id), 'not_found');
    await rejectsWith(identity.resolve('  ', priya.accounts[0]!.id), 'invalid');
    await rejectsWith(identity.upsertAccount('', { platform: 'telegram', externalId: 'x' }, PERSON), 'invalid');
    expect(await identity.accountsWithPrefix(b, priya.accounts[0]!.id.slice(0, 8))).toEqual([]);

    // The owner's own rows still work, and the database itself refuses a cross-owner reference (composite foreign key).
    expect((await identity.resolve(a, priya.accounts[0]!.id))?.name).toBe('Priya');
    await expect(db.query(
      `INSERT INTO accounts (id, owner_id, platform, external_id, person_id) VALUES (?, ?, 'telegram', ?, ?)`,
      [`acc_cross_${b}`, b, `cross-${b}`, priya.person.id],
    )).rejects.toThrow();
  });

  it('creates an account and its person on a first sighting that asks for one, and a repeat sighting creates no rows', async () => {
    const o = owner('seen');
    const first = await identity.upsertAccount(o, { platform: 'telegram', externalId: `t-${o}`, name: 'Bob' }, PERSON);
    expect(first.person?.name).toBe('Bob');
    expect(first.account.personId).toBe(first.person?.id ?? null);
    expect(await rowCounts(o)).toEqual({ people: 1, accounts: 1 });

    const again = await identity.upsertAccount(o, { platform: 'telegram', externalId: `t-${o}`, name: 'Bobby' }, PERSON);
    expect(again.account.id).toBe(first.account.id);
    expect(again.person?.id).toBe(first.person?.id);
    expect(again.account.name).toBe('Bobby');
    expect(again.person?.name).toBe('Bob');
    expect(await rowCounts(o)).toEqual({ people: 1, accounts: 1 });

    // A sighting without a name keeps the name it had; a person with no name is named after the account's platform id.
    expect((await identity.upsertAccount(o, { platform: 'telegram', externalId: `t-${o}` }, NO_PERSON)).account.name).toBe('Bobby');
    const nameless = await identity.upsertAccount(o, { platform: 'discord', externalId: `d-${o}` }, PERSON);
    expect(nameless.person?.name).toBe(`d-${o}`);
  });

  it('records a sender without a person when asked not to, and gives one later when asked', async () => {
    const o = owner('group');
    const before = await rowCounts(o);
    const quiet = await identity.upsertAccount(o, { platform: 'discord', workspace: 'G1', externalId: `q-${o}`, name: 'Quiet' }, NO_PERSON);
    expect(quiet.account.personId).toBeNull();
    expect(quiet.person).toBeUndefined();
    expect(await identity.resolve(o, quiet.account.id)).toBeUndefined();
    expect(await rowCounts(o)).toEqual({ people: before.people, accounts: before.accounts + 1 });

    // Seen again without being addressed: still no person, no new rows.
    const again = await identity.upsertAccount(o, { platform: 'discord', workspace: 'G1', externalId: `q-${o}` }, NO_PERSON);
    expect(again.account.id).toBe(quiet.account.id);
    expect(again.person).toBeUndefined();

    // Addressed later: the same account gets a person; no second account.
    const addressed = await identity.upsertAccount(o, { platform: 'discord', workspace: 'G1', externalId: `q-${o}`, name: 'Quiet' }, PERSON);
    expect(addressed.account.id).toBe(quiet.account.id);
    expect(addressed.person?.name).toBe('Quiet');
    expect(addressed.account.personId).toBe(addressed.person?.id ?? null);
    expect(await rowCounts(o)).toEqual({ people: before.people + 1, accounts: before.accounts + 1 });
  });

  it('creates one person when two first sightings of the same account race', async () => {
    const o = owner('race');
    const [x, y] = await Promise.all([
      identity.upsertAccount(o, { platform: 'slack', workspace: 'T1', externalId: `U-${o}`, name: 'Ann' }, PERSON),
      identity.upsertAccount(o, { platform: 'slack', workspace: 'T1', externalId: `U-${o}`, name: 'Ann' }, PERSON),
    ]);
    expect(x.account.id).toBe(y.account.id);
    expect(x.person?.id).toBe(y.person?.id);
    expect(await rowCounts(o)).toEqual({ people: 1, accounts: 1 });
  });

  it('keeps one person per owner and refuses an unknown platform', async () => {
    const o = owner('one');
    const first = await identity.ensureOwner(o, 'Robin');
    const second = await identity.ensureOwner(o, 'Someone else');
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('Robin');
    expect(second.isOwner).toBe(true);
    await expect(db.query(`INSERT INTO people (id, owner_id, name, is_owner) VALUES (?, ?, 'x', 'true'::text::boolean)`, [`per_second_${o}`, o])).rejects.toThrow();

    await rejectsWith(identity.upsertAccount(o, { platform: 'myspace' as never, externalId: 'x' }, PERSON), 'invalid');
    await expect(db.query(
      `INSERT INTO accounts (id, owner_id, platform, external_id, person_id) VALUES (?, ?, 'myspace', 'x', ?)`,
      [`acc_bad_${o}`, o, first.id],
    )).rejects.toThrow();
  });

  it('links an account to a person, drops the person it leaves when it is empty, and never drops the owner', async () => {
    const o = owner('link');
    const seeded = await seedPeople(db, o, {
      contacts: [
        { name: 'Al', accounts: [{ platform: 'telegram', externalId: `al-${o}` }, { platform: 'slack', workspace: 'T1', externalId: `ALU-${o}` }] },
        { name: 'Bea', accounts: [{ platform: 'discord', externalId: `bea-${o}` }] },
      ],
    });
    const al = seeded.contacts[0]!;
    const beaAccount = seeded.contacts[1]!.accounts[0]!;

    const moved = await identity.linkAccount(o, beaAccount.id, al.person.id);
    expect(moved.personId).toBe(al.person.id);
    expect(await identity.resolve(o, beaAccount.id)).toMatchObject({ id: al.person.id, name: 'Al' });
    expect((await db.query<{ id: string }>('SELECT id FROM people WHERE owner_id = ? ORDER BY id', [o])).map((row) => row.id))
      .toEqual([seeded.owner.id, al.person.id].sort());

    // Linking to the person it already belongs to changes nothing.
    expect((await identity.linkAccount(o, beaAccount.id, al.person.id)).personId).toBe(al.person.id);

    // A person that loses its last account goes away; the owner's person stays with none.
    const mine = await identity.upsertAccount(o, { platform: 'telegram', externalId: `me-${o}`, name: 'Me' }, PERSON);
    await identity.linkAccount(o, mine.account.id, seeded.owner.id);
    expect(await db.query('SELECT id FROM people WHERE owner_id = ? AND id = ?', [o, mine.person?.id ?? ''])).toEqual([]);
    await identity.linkAccount(o, mine.account.id, al.person.id);
    const ownerNow = await db.query<{ id: string }>('SELECT id FROM people WHERE owner_id = ? AND is_owner', [o]);
    expect(ownerNow.map((row) => row.id)).toEqual([seeded.owner.id]);

    await rejectsWith(identity.linkAccount(o, beaAccount.id, `per_nobody_${o}`), 'not_found');
    await rejectsWith(identity.linkAccount(o, `acc_nobody_${o}`, al.person.id), 'not_found');
  });

  it('attaches an account that has no person to a person, without deleting anything', async () => {
    const o = owner('attach');
    const { owner: me, contacts } = await seedPeople(db, o, { contacts: [{ name: 'Cy', accounts: [{ platform: 'telegram', externalId: `cy-${o}` }] }] });
    const quiet = await identity.upsertAccount(o, { platform: 'slack', workspace: 'T9', externalId: `qq-${o}`, name: 'Q' }, NO_PERSON);
    const linked = await identity.linkAccount(o, quiet.account.id, contacts[0]!.person.id);
    expect(linked.personId).toBe(contacts[0]!.person.id);
    expect((await db.query<{ id: string }>('SELECT id FROM people WHERE owner_id = ? ORDER BY id', [o])).map((row) => row.id))
      .toEqual([me.id, contacts[0]!.person.id].sort());
  });

  it('keeps accounts of different workspaces apart', async () => {
    const o = owner('workspace');
    const one = await identity.upsertAccount(o, { platform: 'slack', workspace: 'T1', externalId: 'U1', name: 'A' }, PERSON);
    const two = await identity.upsertAccount(o, { platform: 'slack', workspace: 'T2', externalId: 'U1', name: 'B' }, PERSON);
    expect(two.account.id).not.toBe(one.account.id);
    expect(two.person?.id).not.toBe(one.person?.id);
  });

  it('lists people, creates a person without accounts, lists a person\'s accounts, finds an account, and looks accounts up by id prefix', async () => {
    const o = owner('lists');
    const me = await identity.ensureOwner(o, 'Robin');
    const bob = await identity.upsertAccount(o, { platform: 'telegram', externalId: `b-${o}`, name: 'Bob' }, PERSON);
    const bobSlack = await identity.upsertAccount(o, { platform: 'slack', workspace: 'T1', externalId: `bs-${o}`, name: 'Bob' }, NO_PERSON);
    await identity.linkAccount(o, bobSlack.account.id, bob.person!.id);
    const page = await identity.createPerson(o, '  Mum ');
    expect(page).toMatchObject({ name: 'Mum', isOwner: false });
    expect((await identity.listPeople(o)).map((person) => person.name)).toEqual(['Robin', 'Bob', 'Mum']);
    expect((await identity.accountsOf(o, bob.person!.id)).map((account) => account.externalId)).toEqual([`b-${o}`, `bs-${o}`]);
    expect(await identity.accountsOf(o, page.id)).toEqual([]);
    expect(await identity.findAccount(o, { platform: 'slack', workspace: 'T1', externalId: `bs-${o}` })).toMatchObject({ id: bobSlack.account.id, personId: bob.person!.id });
    expect(await identity.findAccount(o, { platform: 'slack', workspace: 'T2', externalId: `bs-${o}` })).toBeUndefined();
    expect(me.isOwner).toBe(true);

    const prefix = bobSlack.account.id.slice(0, 8);
    expect((await identity.accountsWithPrefix(o, prefix)).map((account) => account.id)).toEqual([bobSlack.account.id]);
    // `_` is not a wildcard: "acc" plus any character does not match an id that is not spelled that way.
    expect(await identity.accountsWithPrefix(o, 'acc_x')).toEqual([]);
  });
});

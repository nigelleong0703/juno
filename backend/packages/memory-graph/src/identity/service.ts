/**
 * The identity graph's rules over the repository. An account is recorded on every sighting; it gets a person only when the caller asks
 * for one (a DM sender, a group sender who addresses the agent, a person_link), so a group-only sender stays an account. A link moves an
 * account and drops the person it left when that person is empty (never the owner). Every method takes the owner id first and checks
 * it is present; every method that writes several rows runs in one transaction on the DurableDb it was given.
 */
import type { DurableDb } from '@agent-desktop/durable';
import * as repo from './repo.js';
import * as relations from '../relations/repo.js';
import { ACCOUNT_PLATFORMS, IdentityError, type Account, type AccountInput, type Person } from './types.js';

export interface Seen {
  account: Account;
  /** The account's person, or undefined when it has none (only possible when `createPerson` was false and it was never linked). */
  person: Person | undefined;
}

export interface Identity {
  /** The owner's own person. Idempotent: a second call returns the same row. */
  ensureOwner(ownerId: string, name: string): Promise<Person>;
  /**
   * Record that an account was seen: a new account is created, a known one has its name and last-seen time refreshed. With
   * `createPerson` the account gets a person (named after the account) when it has none yet; without it, a new account has no person.
   */
  upsertAccount(ownerId: string, input: AccountInput, options: { createPerson: boolean }): Promise<Seen>;
  /** Move an account to `personId`. The person it left (if any) is deleted when nothing is left on it, unless it is the owner. */
  linkAccount(ownerId: string, accountId: string, personId: string): Promise<Account>;
  /**
   * Take an account off its person and give it a person of its own (named after the account), so it stays a person the owner can see
   * and link again. The person it left is deleted when nothing is left on it (never the owner).
   */
  unlinkAccount(ownerId: string, accountId: string): Promise<Account>;
  /** Rename a person of this owner. */
  renamePerson(ownerId: string, personId: string, name: string): Promise<Person>;
  /** The person an account belongs to, or undefined when it has none. */
  resolve(ownerId: string, accountId: string): Promise<Person | undefined>;
  /** The owner's people, oldest first (at most 500). */
  listPeople(ownerId: string): Promise<Person[]>;
  /** A new person with no accounts yet (a people page written before any account of that person was seen). */
  createPerson(ownerId: string, name: string): Promise<Person>;
  /** The accounts of one person. */
  accountsOf(ownerId: string, personId: string): Promise<Account[]>;
  /** The account of a platform sender, or undefined when nothing has seen it. */
  findAccount(ownerId: string, input: AccountInput): Promise<Account | undefined>;
  /** The owner's accounts whose id starts with `prefix` (at most 20). */
  accountsWithPrefix(ownerId: string, prefix: string): Promise<Account[]>;
  /** Every account of the owner, most recently seen first (at most 500). */
  listAccounts(ownerId: string): Promise<Account[]>;
}

const LIST_LIMIT = 500;

function assertText(name: string, value: string): void {
  if (typeof value !== 'string' || value.trim() === '') throw new IdentityError('invalid', `${name} is required`);
}

function assertAccountInput(input: AccountInput): void {
  if (!ACCOUNT_PLATFORMS.some((platform) => platform === input.platform)) {
    throw new IdentityError('invalid', `unknown account platform: ${String(input.platform)}`);
  }
  assertText('external id', input.externalId);
}

function notFound(what: string): never {
  throw new IdentityError('not_found', `${what} not found`);
}

/** Deletes a person that no longer has an account or a relation; the owner is never deleted (a link never deletes the owner). */
async function dropIfEmpty(tx: DurableDb, ownerId: string, previous: repo.PersonRow): Promise<void> {
  if (previous.is_owner || (await repo.countAccounts(tx, ownerId, previous.id)) > 0) return;
  // A person that still has a relation (BACKEND §9.6) stays even with no account: the relation names them.
  if ((await relations.countRelationsOf(tx, ownerId, previous.id)) > 0) return;
  await repo.deletePerson(tx, ownerId, previous.id);
}

export function createIdentity(db: DurableDb): Identity {
  return {
    async ensureOwner(ownerId, name) {
      assertText('owner id', ownerId);
      assertText('owner name', name);
      await repo.insertOwner(db, ownerId, repo.newId('per'), name.trim());
      const owner = await repo.findOwner(db, ownerId);
      if (!owner) throw new Error('the owner person is missing right after its insert');
      return repo.toPerson(owner);
    },

    async upsertAccount(ownerId, input, options) {
      assertText('owner id', ownerId);
      assertAccountInput(input);
      const key = { platform: input.platform, workspace: input.workspace ?? '', externalId: input.externalId };
      const name = input.name?.trim() || null;
      const chat = input.lastChat?.trim() || null;
      return db.transaction(async (tx) => {
        const seen = await repo.findAccount(tx, ownerId, key);
        let row: repo.AccountRow;
        if (seen) {
          row = await repo.touchAccount(tx, ownerId, seen.id, name, chat);
        } else {
          const offered = options.createPerson ? await repo.insertPerson(tx, ownerId, repo.newId('per'), name ?? input.externalId) : undefined;
          row = await repo.insertAccount(tx, ownerId, repo.newId('acc'), offered?.id ?? null, key, name, chat);
          // Another sighting of the same account committed first: its person (or none) stands, ours was never used.
          if (offered !== undefined && row.person_id !== offered.id) await repo.deletePerson(tx, ownerId, offered.id);
        }
        if (options.createPerson && row.person_id === null) {
          const person = await repo.insertPerson(tx, ownerId, repo.newId('per'), name ?? row.external_id);
          row = await repo.moveAccount(tx, ownerId, row.id, person.id);
        }
        const person = row.person_id === null ? undefined : await repo.getPerson(tx, ownerId, row.person_id, false);
        return { account: repo.toAccount(row), person: person === undefined ? undefined : repo.toPerson(person) };
      });
    },

    async linkAccount(ownerId, accountId, personId) {
      assertText('owner id', ownerId);
      assertText('account id', accountId);
      assertText('person id', personId);
      return db.transaction(async (tx) => {
        const account = await repo.getAccount(tx, ownerId, accountId, true);
        if (!account) notFound('account');
        const target = await repo.getPerson(tx, ownerId, personId, true);
        if (!target) notFound('person');
        if (account.person_id === personId) return repo.toAccount(account);
        const previous = account.person_id === null ? undefined : await repo.getPerson(tx, ownerId, account.person_id, true);
        const moved = await repo.moveAccount(tx, ownerId, accountId, personId);
        if (previous) await dropIfEmpty(tx, ownerId, previous);
        return repo.toAccount(moved);
      });
    },

    async unlinkAccount(ownerId, accountId) {
      assertText('owner id', ownerId);
      assertText('account id', accountId);
      return db.transaction(async (tx) => {
        const account = await repo.getAccount(tx, ownerId, accountId, true);
        if (!account) notFound('account');
        const previous = account.person_id === null ? undefined : await repo.getPerson(tx, ownerId, account.person_id, true);
        const alone = await repo.insertPerson(tx, ownerId, repo.newId('per'), account.name ?? account.external_id);
        const moved = await repo.moveAccount(tx, ownerId, accountId, alone.id);
        if (previous) await dropIfEmpty(tx, ownerId, previous);
        return repo.toAccount(moved);
      });
    },

    async renamePerson(ownerId, personId, name) {
      assertText('owner id', ownerId);
      assertText('person id', personId);
      assertText('person name', name);
      return db.transaction(async (tx) => {
        const renamed = await repo.renamePersonRow(tx, ownerId, personId, name.trim());
        if (!renamed) notFound('person');
        return repo.toPerson(renamed);
      });
    },

    async resolve(ownerId, accountId) {
      assertText('owner id', ownerId);
      assertText('account id', accountId);
      const account = await repo.getAccount(db, ownerId, accountId, false);
      if (!account) notFound('account');
      if (account.person_id === null) return undefined;
      const person = await repo.getPerson(db, ownerId, account.person_id, false);
      return person === undefined ? undefined : repo.toPerson(person);
    },

    async listPeople(ownerId) {
      assertText('owner id', ownerId);
      return (await repo.listPeopleRows(db, ownerId, LIST_LIMIT)).map(repo.toPerson);
    },

    async listAccounts(ownerId) {
      assertText('owner id', ownerId);
      return (await repo.listAccountRows(db, ownerId, LIST_LIMIT)).map(repo.toAccount);
    },

    async createPerson(ownerId, name) {
      assertText('owner id', ownerId);
      assertText('person name', name);
      return repo.toPerson(await repo.insertPerson(db, ownerId, repo.newId('per'), name.trim()));
    },

    async accountsOf(ownerId, personId) {
      assertText('owner id', ownerId);
      assertText('person id', personId);
      return (await repo.accountRowsOf(db, ownerId, personId)).map(repo.toAccount);
    },

    async findAccount(ownerId, input) {
      assertText('owner id', ownerId);
      assertAccountInput(input);
      const row = await repo.findAccount(db, ownerId, { platform: input.platform, workspace: input.workspace ?? '', externalId: input.externalId });
      return row === undefined ? undefined : repo.toAccount(row);
    },

    async accountsWithPrefix(ownerId, prefix) {
      assertText('owner id', ownerId);
      assertText('account id prefix', prefix);
      return (await repo.accountsWithPrefix(db, ownerId, prefix)).map(repo.toAccount);
    },
  };
}

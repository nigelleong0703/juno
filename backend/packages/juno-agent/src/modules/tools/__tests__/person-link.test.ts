// person_link: the owner says accounts are one person and the agent links them. Owner-only; the identity graph's own rules are tested in
// packages/memory-graph, so this uses an in-memory identity that follows the same rules (a link moves an account; an empty non-owner person goes).
import { describe, expect, it } from 'vitest';
import type { Account, Person } from '@agent-desktop/memory-graph/identity';
import { createMemoryStore } from '../../../testing/store.js';
import type { MemoryPort } from '../../memory/port.js';
import { createPersonLinkTool } from '../tools/personLink.js';
import { textOf, toolCtx } from './codingFixtures.js';

const AT = '2026-10-01T00:00:00.000Z';
const per = (suffix: string): string => 'per_' + suffix.padEnd(32, '0');
const acc = (suffix: string): string => 'acc_' + suffix.padEnd(32, '0');

const person = (id: string, name: string, isOwner = false): Person => ({ id, ownerId: 'owner', name, isOwner, createdAt: AT, updatedAt: AT });
const account = (id: string, personId: string | null, platform: Account['platform'], externalId: string, name: string, lastChat = ''): Account => ({
  id, ownerId: 'owner', platform, workspace: platform === 'slack' ? 'T1' : '', externalId, name, personId, lastChat, firstSeen: AT, lastSeen: AT,
});

/** The port's people operations in memory, with the rules the identity graph keeps. */
function fakeIdentity(people: Person[], accounts: Account[]): { identity: MemoryPort['people']; people: Map<string, Person>; accounts: Map<string, Account> } {
  const byPerson = new Map(people.map((row) => [row.id, row]));
  const byAccount = new Map(accounts.map((row) => [row.id, row]));
  const identity = {
    async list() {
      return [...byPerson.values()];
    },
    async listAccounts() {
      return [...byAccount.values()];
    },
    async createPerson(_owner: string, name: string) {
      const created = person(per('c' + String(byPerson.size)), name);
      byPerson.set(created.id, created);
      return created;
    },
    async accountsOf(_owner: string, personId: string) {
      return [...byAccount.values()].filter((row) => row.personId === personId);
    },
    async accountsWithPrefix(_owner: string, prefix: string) {
      return [...byAccount.values()].filter((row) => row.id.startsWith(prefix)).slice(0, 20);
    },
    async resolve(_owner: string, accountId: string) {
      const row = byAccount.get(accountId);
      return row?.personId === null || row === undefined ? undefined : byPerson.get(row.personId);
    },
    async linkAccount(_owner: string, accountId: string, personId: string) {
      const row = byAccount.get(accountId);
      if (row === undefined || !byPerson.has(personId)) throw new Error('not found');
      const previous = row.personId;
      byAccount.set(accountId, { ...row, personId });
      if (previous !== null && previous !== personId && ![...byAccount.values()].some((other) => other.personId === previous)) {
        if (byPerson.get(previous)?.isOwner !== true) byPerson.delete(previous);
      }
      return byAccount.get(accountId) as Account;
    },
  };
  return { identity: identity as unknown as MemoryPort['people'], people: byPerson, accounts: byAccount };
}

/** A store with the owner's agent and a direct chat with the owner alone, so the run is owner-only. */
async function ownerOnlyStore(memberIds: string[] = ['owner']) {
  const store = createMemoryStore();
  await store.put('agents', { id: 'agent-1', name: 'Juno', ownerId: 'owner', createdAt: AT } as never);
  await store.put('conversations', { id: 'conv-1', kind: 'direct', agentIds: ['agent-1'], memberIds, ownerId: 'owner', unreadCount: 0, lastItemAt: AT, createdAt: AT } as never);
  return store;
}

// Bob on Slack and Bob on Telegram are the same person: the Slack one is moved onto the Telegram one.
const seed = () => fakeIdentity(
  [person(per('3f2a1b2c'), 'Bob (Slack)'), person(per('9e8d7c6b'), 'Bob'), person(per('0'), 'Owner', true)],
  [account(acc('5a5a'), per('3f2a1b2c'), 'slack', 'U-bob', 'Bob', 'Lunch crew'), account(acc('7b7b'), per('9e8d7c6b'), 'telegram', '77', 'Bob', 'Friends')],
);

describe('person_link', () => {
  it('links an account named by platform and name onto the person of the other account, and the emptied person goes away', async () => {
    const world = seed();
    const tool = createPersonLinkTool({ memory: { people: world.identity } });
    expect(tool.ownerOnly).toBe(true);
    const store = await ownerOnlyStore();
    const result = await tool.execute({ accounts: [{ platform: 'slack', name: 'Bob' }], person: 'Bob' }, toolCtx(store));
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe(`Linked slack "Bob" to Bob (${per('9e8d7c6b').slice(0, 12)}).`);
    expect([...world.accounts.values()].filter((row) => row.personId === per('9e8d7c6b'))).toHaveLength(2);
    expect(world.people.has(per('3f2a1b2c'))).toBe(false);
  });

  it('matches the name case-blind and by handle, and takes ids as well', async () => {
    const world = fakeIdentity(
      [person(per('a1'), 'Ann'), person(per('b2'), 'Ben')],
      [account(acc('c3'), null, 'discord', 'd-9', 'Quiet'), account(acc('d4'), per('b2'), 'telegram', 'ann_handle', 'Annie')],
    );
    const tool = createPersonLinkTool({ memory: { people: world.identity } });
    const store = await ownerOnlyStore();
    const byId = await tool.execute({ accounts: [acc('c3')], person: 'Ann' }, toolCtx(store));
    expect(byId.isError).toBeUndefined();
    expect(world.accounts.get(acc('c3'))?.personId).toBe(per('a1'));
    const byHandle = await tool.execute({ accounts: [{ platform: 'telegram', name: '@ANN_HANDLE' }], person: 'Ann' }, toolCtx(store));
    expect(byHandle.isError).toBeUndefined();
    expect(world.accounts.get(acc('d4'))?.personId).toBe(per('a1'));
    // Ben lost his only account, so his person went; Ann (the owner's chosen person) stays.
    expect(world.people.has(per('b2'))).toBe(false);
    expect(world.people.has(per('a1'))).toBe(true);
  });

  it('creates a person for accounts that have none, named after the first one', async () => {
    const world = fakeIdentity([person(per('a1'), 'Ann')], [account(acc('c3'), null, 'discord', 'd-9', 'Quiet'), account(acc('e5'), null, 'slack', 'U-q', 'Quiet')]);
    const tool = createPersonLinkTool({ memory: { people: world.identity } });
    const store = await ownerOnlyStore();
    const result = await tool.execute({ accounts: [{ platform: 'discord', name: 'Quiet' }, { platform: 'slack', name: 'Quiet' }] }, toolCtx(store));
    expect(result.isError).toBeUndefined();
    const linked = world.accounts.get(acc('c3'))?.personId;
    expect(linked).toBeTruthy();
    expect(world.accounts.get(acc('e5'))?.personId).toBe(linked);
  });

  it('answers with the candidates and their last chat when a name matches more than one account, and links nothing', async () => {
    const world = fakeIdentity(
      [person(per('a1'), 'Ann'), person(per('b2'), 'Ben')],
      [account(acc('c3'), per('a1'), 'slack', 'U-bob', 'Bob', 'Lunch crew'), account(acc('d4'), per('b2'), 'slack', 'U-bob2', 'Bob', 'Book club'), account(acc('e5'), null, 'telegram', '77', 'Bob')],
    );
    const tool = createPersonLinkTool({ memory: { people: world.identity } });
    const store = await ownerOnlyStore();
    const ambiguous = await tool.execute({ accounts: [{ platform: 'slack', name: 'Bob' }, { platform: 'telegram', name: 'Bob' }], person: 'Ann' }, toolCtx(store));
    expect(ambiguous.isError).toBeUndefined();
    const shown = textOf(ambiguous);
    expect(shown).toContain('Nothing was linked');
    expect(shown).toContain('last seen in "Lunch crew"');
    expect(shown).toContain('last seen in "Book club"');
    expect(shown).toContain(`id ${acc('c3').slice(0, 12)}`);
    expect(shown).toContain(`id ${acc('d4').slice(0, 12)}`);
    // The telegram account, which matched once, was not moved either: the whole call links nothing when one reference is ambiguous.
    expect(world.accounts.get(acc('e5'))?.personId).toBeNull();
  });

  it('refuses a name no account has on that platform', async () => {
    const world = seed();
    const tool = createPersonLinkTool({ memory: { people: world.identity } });
    const store = await ownerOnlyStore();
    const unknown = await tool.execute({ accounts: [{ platform: 'discord', name: 'Bob' }], person: 'Bob' }, toolCtx(store));
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('no discord account is called "Bob"');
  });

  it('is refused in a run with anyone else in it, and never moves the owner\'s own person', async () => {
    const world = seed();
    const tool = createPersonLinkTool({ memory: { people: world.identity } });
    const shared = await ownerOnlyStore(['owner', 'someone-else']);
    const refused = await tool.execute({ accounts: [per('3f2a1b2c')], person: per('9e8d7c6b') }, toolCtx(shared));
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('only available in a chat with your owner alone');
    expect(world.people.has(per('3f2a1b2c'))).toBe(true);

    const alone = await ownerOnlyStore();
    const owner = await tool.execute({ accounts: [per('0')], person: per('9e8d7c6b') }, toolCtx(alone));
    expect(owner.isError).toBe(true);
    expect(textOf(owner)).toContain('owner\'s own person');
  });

  it('answers with the candidates when a short id matches more than one person, and refuses an unknown one', async () => {
    const world = fakeIdentity(
      [person(per('3f2a1b2c'), 'Ann'), person('per_3f2a1b2c' + '1'.repeat(24), 'Anna'), person(per('9e8d7c6b'), 'Ben')],
      [account(acc('5a5a'), per('9e8d7c6b'), 'telegram', '77', 'Ben')],
    );
    const tool = createPersonLinkTool({ memory: { people: world.identity } });
    const store = await ownerOnlyStore();
    const ambiguous = await tool.execute({ accounts: ['per_3f2a1b2c'], person: per('9e8d7c6b') }, toolCtx(store));
    expect(ambiguous.isError).toBe(true);
    expect(textOf(ambiguous)).toContain('matches more than one person: Ann (per_3f2a1b2c); Anna (per_3f2a1b2c)');

    const unknown = await tool.execute({ accounts: ['per_ffffffff'], person: per('9e8d7c6b') }, toolCtx(store));
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('no person matches');
  });

  it('refuses without an owner context and bad arguments', async () => {
    const tool = createPersonLinkTool({ memory: { people: seed().identity } });
    const store = await ownerOnlyStore();
    const bad = await tool.execute({ accounts: [] }, toolCtx(store));
    expect(bad.isError).toBe(true);
  });
});

/**
 * memoryd contract and behaviour (BACKEND §2.4). The same suite runs against the in-process port and the remote port (memoryd served
 * in this process on a random port), so every `MemoryPort` method is held to one behaviour. The remote-only checks cover the bearer,
 * the owner header, presence enforced by the server, and the degrade when memoryd is down.
 */
import { createServer, type AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { createIdentity, IdentityError } from '@agent-desktop/memory-graph/identity';
import { MemoryItemError, createMemoryItems, type Presence } from '@agent-desktop/memory-graph/memory';
import { createRelations, RelationError } from '@agent-desktop/memory-graph/relations';
import { startTestDatabase, type TestDatabase } from '@agent-desktop/memory-graph/testing';
import { HomeConflictError } from 'juno-agent/modules/home/service';
import type { MemoryGraph } from 'juno-agent/modules/memory/graph';
import { createMemoryPort, type MemoryPort } from 'juno-agent/modules/memory/port';
import { createRemoteMemoryPort } from '../client.js';
import { MemoryUnavailableError } from '../contract.js';
import { createMemoryServer } from '../server.js';

const TOKEN = 'test-memoryd-token-0123456789';
const AGENT = 'agent-test';

let database: TestDatabase;
let graph: MemoryGraph;
let inProcess: MemoryPort;
let remote: MemoryPort;
let url: string;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  database = await startTestDatabase();
  graph = { items: createMemoryItems(database.db), identity: createIdentity(database.db), relations: createRelations(database.db) };
  inProcess = createMemoryPort({ store: createMemoryStore(), graph });
  const app = createMemoryServer({ port: inProcess, token: TOKEN });
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const started = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(started));
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = () => new Promise<void>((resolve) => server.close(() => resolve()));
  remote = createRemoteMemoryPort({ url, token: TOKEN, graph });
}, 240_000);

afterAll(async () => {
  await closeServer?.();
  await database?.close();
});

const freshOwner = (): string => 'owner-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

/** Writes one owner fact, one group fact and one public fact, and returns the owner's fact. */
async function seed(port: MemoryPort, owner: string) {
  const ownerFact = await port.addItem(owner, { text: 'Owner secret fact', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner' });
  await port.addItem(owner, { text: 'Group fact', kind: 'fact', file: 'memory', saidIn: 'group:G1', audience: 'group:G1' });
  await port.addItem(owner, { text: 'Public fact', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'public' });
  if (ownerFact === null) throw new Error('seed: owner fact was not written');
  return ownerFact;
}

const texts = (items: ReadonlyArray<{ text: string }>): string[] => items.map((item) => item.text).sort();

const PORTS: Array<[string, () => MemoryPort]> = [
  ['in-process', () => inProcess],
  ['remote', () => remote],
];

describe.each(PORTS)('MemoryPort contract (%s)', (_name, portOf) => {
  it('addItem writes an item and returns null for a legacy ref already taken', async () => {
    const port = portOf();
    const owner = freshOwner();
    const legacyRef = 'legacy-' + owner;
    const first = await port.addItem(owner, { text: 'Likes green tea.', kind: 'preference', file: 'bank:preferences', saidIn: 'migrated', audience: 'owner', legacyRef });
    expect(first).toMatchObject({ ownerId: owner, text: 'Likes green tea.', kind: 'preference', file: 'bank:preferences', status: 'active' });
    await expect(port.addItem(owner, { text: 'Likes green tea.', kind: 'preference', file: 'bank:preferences', saidIn: 'migrated', audience: 'owner', legacyRef })).resolves.toBeNull();
  });

  it('note updates the item that already says it instead of adding a second, and topics list the sections of the owner\'s items', async () => {
    const port = portOf();
    const owner = freshOwner();
    const input = { text: 'Wants less sugar', kind: 'preference' as const, file: 'bank:preferences' as const, saidIn: 'app', audience: 'owner', topic: 'health' as const };
    const first = await port.note(owner, input);
    expect(first).toMatchObject({ updated: false, item: { text: 'Wants less sugar', topic: 'health' } });
    const again = await port.note(owner, { ...input, text: 'wants less SUGAR.' });
    expect(again).toMatchObject({ updated: true, item: { id: first?.item.id, text: 'wants less SUGAR.' } });
    expect(await port.owner.items(owner, {})).toHaveLength(1);
    expect(await port.owner.items(owner, { topic: 'work' })).toEqual([]);
    expect(await port.owner.items(owner, { topic: 'health' })).toHaveLength(1);
    await graph.items.putTopicSummary(owner, 'health', `You're [[${first?.item.id}|cutting sugar]].`);
    expect(await port.owner.topics(owner)).toEqual([expect.objectContaining({
      topic: 'health', summary: "You're cutting sugar.", count: 1, segments: [{ text: "You're " }, { text: 'cutting sugar', itemId: first?.item.id }, { text: '.' }],
    })]);
  });

  it('addItem refuses bad input with the memory-graph error class', async () => {
    const port = portOf();
    await expect(port.addItem(freshOwner(), { text: '   ', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner' })).rejects.toBeInstanceOf(MemoryItemError);
  });

  it('memoryFor returns only what each presence may see', async () => {
    const port = portOf();
    const owner = freshOwner();
    await seed(port, owner);
    const ownerView = await port.memoryFor(owner, { kind: 'owner' }, undefined);
    expect(texts(ownerView)).toEqual(['Group fact', 'Owner secret fact', 'Public fact'].sort());
    const group: Presence = { kind: 'group', groupKey: 'G1' };
    expect(texts(await port.memoryFor(owner, group, undefined))).toEqual(['Group fact', 'Public fact']);
    expect(texts(await port.memoryFor(owner, { kind: 'group', groupKey: 'G2' }, undefined))).toEqual(['Public fact']);
    expect(texts(await port.memoryFor(owner, { kind: 'other' }, undefined))).toEqual(['Public fact']);
  });

  it('search ranks the items the presence may see', async () => {
    const port = portOf();
    const owner = freshOwner();
    await seed(port, owner);
    const hits = await port.search({ ownerId: owner, presence: { kind: 'owner' }, agentId: undefined, query: 'secret' });
    expect(hits.map((hit) => hit.item.text)).toEqual(['Owner secret fact']);
    expect(await port.search({ ownerId: owner, presence: { kind: 'other' }, agentId: undefined, query: 'secret' })).toEqual([]);
  });

  it('section lists the items the presence may see', async () => {
    const port = portOf();
    const owner = freshOwner();
    await seed(port, owner);
    const run = { ownerId: owner, agentId: AGENT, wake: [], canNote: false, people: [], runStart: false, delivered: new Set<string>() };
    const forOwner = await port.section({ ...run, presence: { kind: 'owner' } });
    expect(forOwner.section).toContain('Owner secret fact');
    const forStranger = await port.section({ ...run, presence: { kind: 'other' } });
    expect(forStranger.section).toContain('Public fact');
    expect(forStranger.section).not.toContain('Owner secret fact');
  });

  it('explain says where an item came from for the owner', async () => {
    const port = portOf();
    const owner = freshOwner();
    const item = await seed(port, owner);
    const explanation = await port.explain({ ownerId: owner, presence: { kind: 'owner' }, agentId: undefined, reference: { kind: 'mem', id: item.id } });
    expect(explanation.kind).toBe('item');
  });

  it('forget with no claims retracts nothing', async () => {
    const port = portOf();
    const owner = freshOwner();
    await seed(port, owner);
    await expect(port.forget({ ownerId: owner, agentId: AGENT, claimIds: [] })).resolves.toEqual({ retracted: 0, removedLines: 0 });
  });

  it('saveView resolves for an owner edit that matches the view hash', async () => {
    const port = portOf();
    const owner = freshOwner();
    await seed(port, owner);
    await expect(port.saveView({ ownerId: owner, path: 'memory/bank/preferences.md', content: '# Preferences\n' })).resolves.toBeDefined();
  });

  it('saveView with a stale hash refuses with the home conflict class', async () => {
    const port = portOf();
    const owner = freshOwner();
    await seed(port, owner);
    await expect(port.saveView({ ownerId: owner, path: 'memory/bank/preferences.md', content: '# Preferences\n', expectedHash: 'stale' })).rejects.toBeInstanceOf(HomeConflictError);
  });

  it('renderViews resolves without a computer home', async () => {
    const port = portOf();
    const owner = freshOwner();
    await seed(port, owner);
    await expect(port.renderViews({ ownerId: owner, agentId: AGENT })).resolves.toBeUndefined();
  });

  it('people: owner, persons, and lookups (unknown account is undefined)', async () => {
    const port = portOf();
    const owner = freshOwner();
    const me = await port.people.ensureOwner(owner, 'Robin');
    expect(me.isOwner).toBe(true);
    const ana = await port.people.createPerson(owner, 'Ana');
    expect((await port.people.list(owner)).map((person) => person.name).sort()).toEqual(['Ana', 'Robin']);
    await expect(port.people.resolve(owner, 'acc_missing')).rejects.toBeInstanceOf(IdentityError);
    expect(await port.people.findAccount(owner, { platform: 'telegram', externalId: 'missing' })).toBeUndefined();
    expect(ana.ownerId).toBe(owner);
  });

  it('accounts: find, list, link and resolve', async () => {
    const port = portOf();
    const owner = freshOwner();
    await graph.identity.upsertAccount(owner, { platform: 'telegram', externalId: '777', name: 'Bo' }, { createPerson: true });
    const account = await port.people.findAccount(owner, { platform: 'telegram', externalId: '777' });
    if (account === undefined || account.personId === null) throw new Error('the seeded account was not found');
    expect((await port.people.listAccounts(owner)).map((row) => row.externalId)).toContain('777');
    expect((await port.people.accountsOf(owner, account.personId)).map((row) => row.id)).toContain(account.id);
    expect(Array.isArray(await port.people.accountsWithPrefix(owner, 'tele'))).toBe(true);
    const resolved = await port.people.resolve(owner, account.id);
    expect(resolved?.id).toBe(account.personId);
    const other = await port.people.createPerson(owner, 'Cleo');
    const linked = await port.people.linkAccount(owner, account.id, other.id);
    expect(linked.personId).toBe(other.id);
  });

  it('relations: record a statement and read it back', async () => {
    const port = portOf();
    const owner = freshOwner();
    const ana = await port.people.createPerson(owner, 'Ana');
    const ben = await port.people.createPerson(owner, 'Ben');
    const outcome = await port.relations.record(owner, { a: ana.id, kind: 'manager_of', b: ben.id, evidence: { itemId: 'mem_x', quote: 'Ana manages Ben' }, confirmed: true });
    expect(outcome.outcome).toBe('added');
    const current = await port.relations.currentOf(owner, ana.id);
    expect(current.map((row) => [row.personAName, row.kind, row.personBName])).toEqual([['Ana', 'manager_of', 'Ben']]);
  });

  it('digest: the context carries its sender lookup as maps, and an empty answer applies cleanly', async () => {
    const port = portOf();
    const owner = freshOwner();
    const { context, prompt } = await port.digestContext({ ownerId: owner, items: [], agents: [{ id: AGENT, name: 'Juno' }] });
    expect(typeof prompt).toBe('string');
    expect(context.agents).toEqual([{ id: AGENT, name: 'Juno' }]);
    expect(context.senders.labels).toBeInstanceOf(Map);
    expect(context.senders.senderOf).toBeInstanceOf(Map);
    const applied = await port.applyDigest({ ownerId: owner, agentId: AGENT, items: [], claims: [], context, now: new Date('2026-10-26T00:00:00.000Z') });
    expect(applied.claims.accepted).toBe(0);
    expect(applied.relations.accepted).toBe(0);
  });

  it('owner people: each person with accounts and open relations, most recent activity first', async () => {
    const port = portOf();
    const owner = freshOwner();
    const me = await port.people.ensureOwner(owner, 'Robin');
    const ana = await port.people.createPerson(owner, 'Ana');
    const ben = await port.people.createPerson(owner, 'Ben');
    const seen = await graph.identity.upsertAccount(owner, { platform: 'telegram', externalId: 'ana-1', name: 'Ana', lastChat: 'Family' }, { createPerson: false });
    await port.people.linkAccount(owner, seen.account.id, ana.id);
    await port.relations.record(owner, { a: ana.id, kind: 'manager_of', b: ben.id, evidence: { itemId: 'mem_x', quote: 'Ana manages Ben' }, confirmed: true });
    const views = await port.owner.people(owner);
    expect(views.map((view) => view.person.id).sort()).toEqual([me.id, ana.id, ben.id].sort());
    const anaView = views.find((view) => view.person.id === ana.id);
    expect(anaView?.accounts.map((account) => account.externalId)).toEqual(['ana-1']);
    expect(anaView?.relations).toEqual([{ id: expect.any(String), kind: 'manager_of', kindLabel: null, otherPersonId: ben.id, otherName: 'Ben', direction: 'out', confirmed: true }]);
    expect(views.find((view) => view.person.id === ben.id)?.relations).toEqual([expect.objectContaining({ direction: 'in', otherName: 'Ana' })]);
    const activity = views.map((view) => view.lastActivityAt);
    expect(activity).toEqual([...activity].sort((a, b) => b.localeCompare(a)));
  });

  it('owner possible matches: an account named like a person and not linked to them; linking it removes the match', async () => {
    const port = portOf();
    const owner = freshOwner();
    const ana = await port.people.createPerson(owner, 'Ana');
    const seen = await graph.identity.upsertAccount(owner, { platform: 'slack', workspace: 'T1', externalId: 'U9', name: 'ana' }, { createPerson: false });
    expect((await port.owner.possibleMatches(owner)).map((match) => [match.account.id, match.person.id])).toEqual([[seen.account.id, ana.id]]);
    await port.people.linkAccount(owner, seen.account.id, ana.id);
    expect(await port.owner.possibleMatches(owner)).toEqual([]);
  });

  it('owner unlink: the account leaves its person for one of its own, and the person it left goes when empty', async () => {
    const port = portOf();
    const owner = freshOwner();
    const cleo = await port.people.createPerson(owner, 'Cleo');
    const seen = await graph.identity.upsertAccount(owner, { platform: 'telegram', externalId: 'bo-1', name: 'Bo' }, { createPerson: false });
    await port.people.linkAccount(owner, seen.account.id, cleo.id);
    const unlinked = await port.owner.unlinkAccount(owner, seen.account.id);
    expect(unlinked.personId).not.toBe(cleo.id);
    expect((await port.people.resolve(owner, seen.account.id))?.name).toBe('Bo');
    expect((await port.people.list(owner)).map((person) => person.name)).not.toContain('Cleo');
  });

  it('owner rename: the person gets the new name, and another owner\'s person is not found', async () => {
    const port = portOf();
    const owner = freshOwner();
    const ana = await port.people.createPerson(owner, 'Ana');
    expect((await port.owner.renamePerson(owner, ana.id, 'Ana Lee')).name).toBe('Ana Lee');
    await expect(port.owner.renamePerson(freshOwner(), ana.id, 'Mallory')).rejects.toBeInstanceOf(IdentityError);
  });

  it('owner relations: confirm an unconfirmed statement, then delete it; deleting it again is not found', async () => {
    const port = portOf();
    const owner = freshOwner();
    const ana = await port.people.createPerson(owner, 'Ana');
    const ben = await port.people.createPerson(owner, 'Ben');
    await port.relations.record(owner, { a: ana.id, kind: 'friend', b: ben.id, evidence: { itemId: 'mem_y', quote: 'Ana and Ben are friends' }, confirmed: false });
    const [row] = await port.relations.currentOf(owner, ana.id);
    if (row === undefined) throw new Error('the relation was not recorded');
    expect((await port.owner.confirmRelation(owner, row.id)).confirmed).toBe(true);
    await port.owner.deleteRelation(owner, row.id);
    expect(await port.relations.currentOf(owner, ana.id)).toEqual([]);
    await expect(port.owner.deleteRelation(owner, row.id)).rejects.toBeInstanceOf(RelationError);
  });

  it('owner items: list by status, widen the audience (a stranger now sees it), reword and delete', async () => {
    const port = portOf();
    const owner = freshOwner();
    const item = await seed(port, owner);
    const pending = await port.addItem(owner, { text: 'Maybe moved to Lisbon', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner', status: 'needs_review' });
    if (pending === null) throw new Error('the pending item was not written');
    expect((await port.owner.items(owner, { status: 'needs_review' })).map((row) => row.id)).toEqual([pending.id]);
    expect(await port.owner.items(owner, {})).toHaveLength(4);
    expect(texts(await port.memoryFor(owner, { kind: 'other' }, undefined))).toEqual(['Public fact']);
    expect((await port.owner.updateItem(owner, item.id, { audience: 'public' })).audience).toBe('public');
    expect(texts(await port.memoryFor(owner, { kind: 'other' }, undefined))).toEqual(['Owner secret fact', 'Public fact']);
    const reworded = await port.owner.updateItem(owner, item.id, { audience: 'owner', text: 'Owner secret, reworded' });
    expect([reworded.audience, reworded.text]).toEqual(['owner', 'Owner secret, reworded']);
    await expect(port.owner.updateItem(owner, item.id, { aboutPersonId: 'per_missing' })).rejects.toBeInstanceOf(IdentityError);
    await expect(port.owner.updateItem(owner, 'mem_missing', { text: 'x' })).rejects.toBeInstanceOf(MemoryItemError);
    await port.owner.deleteItem(owner, pending.id);
    expect(await port.owner.items(owner, { status: 'needs_review' })).toEqual([]);
    await expect(port.owner.deleteItem(owner, 'mem_missing')).rejects.toBeInstanceOf(MemoryItemError);
  });

  it('owner delete of a claim-made item removes it even when its claim row is gone', async () => {
    const port = portOf();
    const owner = freshOwner();
    const claimed = await port.addItem(owner, { text: 'Drinks oat milk', kind: 'preference', file: 'bank:preferences', saidIn: 'app', audience: 'owner', claimId: 'clm_orphan_' + owner });
    if (claimed === null) throw new Error('the claimed item was not written');
    await port.owner.deleteItem(owner, claimed.id);
    expect(await port.owner.items(owner, {})).toEqual([]);
  });

  it('the graph is this process\'s own graph', () => {
    expect(portOf().graph).toBe(graph);
  });
});

describe('memoryd server (remote)', () => {
  const post = (route: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${url}/v1/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('answers /healthz without a token and refuses every /v1 call without the bearer (401)', async () => {
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    const owner = freshOwner();
    const body = { ownerId: owner, presence: { kind: 'owner' } };
    expect((await post('memory/memoryFor', body, { 'x-owner-id': owner })).status).toBe(401);
    expect((await post('memory/memoryFor', body, { 'x-owner-id': owner, authorization: 'Bearer wrong-token-value-0000000000' })).status).toBe(401);
  });

  it('refuses a request whose owner header does not match the body (403)', async () => {
    const owner = freshOwner();
    const response = await post('memory/memoryFor', { ownerId: owner, presence: { kind: 'owner' } }, { 'x-owner-id': 'someone-else', authorization: `Bearer ${TOKEN}` });
    expect(response.status).toBe(403);
  });

  it('refuses a body that does not match the route (400)', async () => {
    const owner = freshOwner();
    const response = await post('memory/memoryFor', { ownerId: owner, presence: { kind: 'nobody' } }, { 'x-owner-id': owner, authorization: `Bearer ${TOKEN}` });
    expect(response.status).toBe(400);
  });

  it('enforces presence on the server: a group caller never gets owner-only items, from memoryFor or search', async () => {
    const owner = freshOwner();
    await seed(inProcess, owner);
    const headers = { 'x-owner-id': owner, authorization: `Bearer ${TOKEN}` };
    const memoryFor = await post('memory/memoryFor', { ownerId: owner, presence: { kind: 'group', groupKey: 'G1' } }, headers);
    const items = (await memoryFor.json()) as Array<{ audience: string; text: string }>;
    expect(items.map((item) => item.audience).sort()).toEqual(['group:G1', 'public']);
    const search = await post('memory/search', { ownerId: owner, presence: { kind: 'group', groupKey: 'G1' }, query: 'secret' }, headers);
    expect(await search.json()).toEqual([]);
  });

  it('a stranger gets nothing private through section', async () => {
    const owner = freshOwner();
    await seed(inProcess, owner);
    const section = await remote.section({ ownerId: owner, agentId: AGENT, presence: { kind: 'other' }, wake: [], canNote: false, people: [], runStart: false, delivered: new Set() });
    expect(section.section).not.toContain('Owner secret fact');
    expect(section.section).not.toContain('Group fact');
  });

  it('degrades when memoryd is down: reads are empty, writes throw a clear error, and the warning is logged once a minute', async () => {
    const free = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const log = vi.fn();
    const down = createRemoteMemoryPort({ url: `http://127.0.0.1:${free}`, token: TOKEN, graph, log, timeoutMs: 2_000 });
    const owner = freshOwner();
    expect(await down.memoryFor(owner, { kind: 'owner' }, undefined)).toEqual([]);
    expect(await down.memoryFor(owner, { kind: 'owner' }, undefined)).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(await down.section({ ownerId: owner, agentId: AGENT, presence: { kind: 'owner' }, wake: [], canNote: false, people: [], runStart: false, delivered: new Set() })).toEqual({ section: '' });
    await expect(down.addItem(owner, { text: 'x', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner' })).rejects.toBeInstanceOf(MemoryUnavailableError);
    await expect(down.search({ ownerId: owner, presence: { kind: 'owner' }, agentId: undefined, query: 'x' })).rejects.toBeInstanceOf(MemoryUnavailableError);
  });
});

/**
 * person_lookup on the embedded Postgres: what a person said comes only through memoryFor(presence), so a group sees what the group may
 * hear; the accounts and the relations between people are shown only when the owner is alone with the agent; a miss and a person with
 * nothing to share read the same outside the owner's run; and one owner never finds another owner's people.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupNoteKey } from '../../groups/note.js';
import { createMemoryStore } from '../../../testing/store.js';
import { portOf, startMemoryGraph, type MemoryGraphFixture } from '../../memory/__tests__/memory-graph-fixture.js';
import { createPersonLookupTool } from '../tools/personLookup.js';
import { textOf, toolCtx } from './codingFixtures.js';

let graph: MemoryGraphFixture;

beforeAll(async () => {
  graph = await startMemoryGraph();
}, 240_000);

afterAll(async () => {
  await graph?.close();
});

const AT = '2026-10-26T10:00:00.000Z';
const AGT = 'agent-1';
const TELEGRAM = { kind: 'telegram', channelId: 'bot-1', chatId: '-100' };

/** A store with the owner's agent, a direct chat with the owner alone, and a Telegram group with one other member. */
async function storeFor(owner: string): Promise<ReturnType<typeof createMemoryStore>> {
  const store = createMemoryStore();
  await store.put('agents', { id: AGT, name: 'Juno', ownerId: owner, createdAt: AT } as never);
  await store.put('conversations', { id: 'c-app', kind: 'direct', agentIds: [AGT], memberIds: [owner], ownerId: owner, unreadCount: 0, lastItemAt: AT, createdAt: AT } as never);
  await store.put('conversations', { id: 'c-group', kind: 'room', title: 'Family', agentIds: [AGT], memberIds: [owner, 'ext-alice'], ownerId: owner, channel: TELEGRAM, createdAt: AT } as never);
  return store;
}

/** The tool context of a run in the given conversation, for this owner. */
function ctxFor(store: ReturnType<typeof createMemoryStore>, owner: string, conversationId: string) {
  const base = toolCtx(store);
  return { ...base, ownerId: owner, conversationId, wake: { ...base.wake, ownerId: owner, agentId: AGT, conversationId } };
}

describe('person_lookup', () => {
  it('shows the owner alone everything about a person: what they said, their accounts and their connections', async () => {
    const owner = 'owner-lookup-' + randomUUID().slice(0, 8);
    const store = await storeFor(owner);
    const { identity, relations, items } = graph.graph;
    await identity.ensureOwner(owner, 'Robin');
    const tom = await identity.upsertAccount(owner, { platform: 'telegram', externalId: 'tom-1', name: 'Tom' }, { createPerson: true });
    const priya = await identity.createPerson(owner, 'Priya');
    await relations.record(owner, { a: tom.person!.id, kind: 'manager_of', b: priya.id, evidence: { itemId: 'x', quote: 'q' }, confirmed: true });
    await items.addItem(owner, { text: 'We ship the release on Friday.', kind: 'fact', file: 'memory', saidIn: 'group:' + groupNoteKey(owner, { ...TELEGRAM, workspace: '' }), audience: 'group:' + groupNoteKey(owner, { ...TELEGRAM, workspace: '' }), saidByPersonId: tom.person!.id, createdAt: AT });
    await items.addItem(owner, { text: 'Tom likes async standups.', kind: 'preference', file: 'bank:preferences', saidIn: 'app', audience: 'owner', saidByPersonId: tom.person!.id, createdAt: '2026-10-26T11:00:00.000Z' });

    const tool = createPersonLookupTool({ memory: portOf(graph, store) });
    const result =textOf(await tool.execute({ name: 'Tom' }, ctxFor(store, owner, 'c-app')));
    expect(result).toContain('We ship the release on Friday.');
    expect(result).toContain('Tom likes async standups.');
    expect(result).toContain('Accounts:');
    expect(result).toContain('telegram "Tom" (tom-1)');

    const boss = textOf(await tool.execute({ name: 'Priya' }, ctxFor(store, owner, 'c-app')));
    expect(boss).toContain('Connections:');
    expect(boss).toContain('Tom manages Priya (confirmed by you');
  });

  it('shows a group only what the group may hear, and no accounts or connections', async () => {
    const owner = 'owner-group-' + randomUUID().slice(0, 8);
    const store = await storeFor(owner);
    const { identity, relations, items } = graph.graph;
    await identity.ensureOwner(owner, 'Robin');
    const tom = await identity.upsertAccount(owner, { platform: 'telegram', externalId: 'tom-2', name: 'Tom' }, { createPerson: true });
    const priya = await identity.createPerson(owner, 'Priya');
    await relations.record(owner, { a: tom.person!.id, kind: 'manager_of', b: priya.id, evidence: { itemId: 'x', quote: 'q' }, confirmed: true });
    const key = 'group:' + groupNoteKey(owner, { ...TELEGRAM, workspace: '' });
    await items.addItem(owner, { text: 'We ship the release on Friday.', kind: 'fact', file: 'memory', saidIn: key, audience: key, saidByPersonId: tom.person!.id, createdAt: AT });
    await items.addItem(owner, { text: 'Tom likes async standups.', kind: 'preference', file: 'bank:preferences', saidIn: 'app', audience: 'owner', saidByPersonId: tom.person!.id, createdAt: '2026-10-26T11:00:00.000Z' });
    await items.addItem(owner, { text: 'Tom is looking for a new job.', kind: 'circumstance', file: 'bank:circumstances', saidIn: key, audience: key, sensitive: true, saidByPersonId: tom.person!.id, createdAt: '2026-10-26T12:00:00.000Z' });

    const tool = createPersonLookupTool({ memory: portOf(graph, store) });
    const group =textOf(await tool.execute({ name: 'Tom' }, ctxFor(store, owner, 'c-group')));
    expect(group).toContain('We ship the release on Friday.');
    expect(group).not.toContain('async standups');
    expect(group).not.toContain('new job');
    expect(group).not.toContain('Accounts:');
    expect(group).not.toContain('Connections:');
    expect(group).not.toContain('tom-2');
  });

  it('gives a miss and a person with nothing to share the same answer outside the owner\'s run', async () => {
    const owner = 'owner-miss-' + randomUUID().slice(0, 8);
    const store = await storeFor(owner);
    const { identity, items } = graph.graph;
    await identity.ensureOwner(owner, 'Robin');
    const lee = await identity.createPerson(owner, 'Lee');
    await items.addItem(owner, { text: 'Lee likes sailing.', kind: 'preference', file: 'bank:preferences', saidIn: 'app', audience: 'owner', saidByPersonId: lee.id, createdAt: AT });

    const tool = createPersonLookupTool({ memory: portOf(graph, store) });
    const nobody =textOf(await tool.execute({ name: 'Nobody' }, ctxFor(store, owner, 'c-group')));
    const hidden = textOf(await tool.execute({ name: 'Lee' }, ctxFor(store, owner, 'c-group')));
    expect(nobody).toBe('Nothing you can share about Nobody here.');
    expect(hidden).toBe('Nothing you can share about Lee here.');
    const owned = await tool.execute({ name: 'Nobody' }, ctxFor(store, owner, 'c-app'));
    expect(owned.isError).toBe(true);
    expect(textOf(owned)).toContain('No person is called');
  });

  it('never finds another owner\'s people', async () => {
    const alice = 'owner-alice-' + randomUUID().slice(0, 8);
    const bob = 'owner-bob-' + randomUUID().slice(0, 8);
    const aliceStore = await storeFor(alice);
    const bobStore = await storeFor(bob);
    await graph.graph.identity.ensureOwner(alice, 'Alice');
    await graph.graph.identity.ensureOwner(bob, 'Bob');
    const carol = await graph.graph.identity.createPerson(alice, 'Carol');
    await graph.graph.items.addItem(alice, { text: 'Carol moves in May.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner', saidByPersonId: carol.id, createdAt: AT });

    const tool = createPersonLookupTool({ memory: portOf(graph, aliceStore) });
    const fromBob =await tool.execute({ name: 'Carol' }, ctxFor(bobStore, bob, 'c-app'));
    expect(fromBob.isError).toBe(true);
    expect(textOf(fromBob)).not.toContain('May');
    const fromAlice = textOf(await tool.execute({ name: 'Carol' }, ctxFor(aliceStore, alice, 'c-app')));
    expect(fromAlice).toContain('Carol moves in May.');
  });
});

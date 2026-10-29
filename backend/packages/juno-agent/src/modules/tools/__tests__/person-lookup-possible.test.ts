/**
 * person_lookup with the names of the multi-hop case and with possible matches (BACKEND §9.6): "Priya" in any form reaches her; an
 * account with the name that is not linked to the person is a possible match, shown to the owner alone, never linked here; a group sees
 * no account and no possible match.
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

async function storeFor(owner: string): Promise<ReturnType<typeof createMemoryStore>> {
  const store = createMemoryStore();
  await store.put('agents', { id: AGT, name: 'Juno', ownerId: owner, createdAt: AT } as never);
  await store.put('conversations', { id: 'c-app', kind: 'direct', agentIds: [AGT], memberIds: [owner], ownerId: owner, unreadCount: 0, lastItemAt: AT, createdAt: AT } as never);
  await store.put('conversations', { id: 'c-group', kind: 'room', title: 'Release crew', agentIds: [AGT], memberIds: [owner, 'ext-alice'], ownerId: owner, channel: TELEGRAM, createdAt: AT } as never);
  return store;
}

function ctxFor(store: ReturnType<typeof createMemoryStore>, owner: string, conversationId: string) {
  const base = toolCtx(store);
  return { ...base, ownerId: owner, conversationId, wake: { ...base.wake, ownerId: owner, agentId: AGT, conversationId } };
}

/** The audience and place of an item said in the "Release crew" room, as a run in that room computes its key (no workspace). */
const groupKeyOf = (owner: string): string => 'group:' + groupNoteKey(owner, { ...TELEGRAM, workspace: '' });

describe('person_lookup: the names of the multi-hop case', () => {
  it('"Priya" reaches her in any form: case, spaces, a possessive, a curly apostrophe', async () => {
    const owner = 'owner-forms-' + randomUUID().slice(0, 8);
    const store = await storeFor(owner);
    await graph.graph.identity.ensureOwner(owner, 'Robin');
    await graph.graph.identity.createPerson(owner, 'Priya');
    const tool = createPersonLookupTool({ memory: portOf(graph, store) });
    for (const form of ['Priya', 'priya', ' Priya ', "Priya's", 'Priya’s']) {
      const text = textOf(await tool.execute({ name: form }, ctxFor(store, owner, 'c-app')));
      expect(text, JSON.stringify(form)).toContain('Priya (per_');
      expect(text, JSON.stringify(form)).not.toContain('No person is called');
    }
  });
});

describe('person_lookup: what an unlinked account wrote', () => {
  it('shows its latest three messages, newest first, in the chats it spoke in, cut at 300 characters, and no other account\'s', async () => {
    const owner = 'owner-msgs-' + randomUUID().slice(0, 8);
    const store = await storeFor(owner);
    const { identity } = graph.graph;
    await identity.ensureOwner(owner, 'Robin');
    await identity.createPerson(owner, 'Tom');
    await identity.upsertAccount(owner, { platform: 'telegram', externalId: 'tg-tom-m', name: 'Tom', lastChat: 'Release crew' }, { createPerson: false });
    const chat = (id: string, at: string, externalId: string, text: string) => store.put('items', { id, ownerId: owner, conversationId: 'c-group', at, type: 'user_message', authorId: 'ext-telegram-y', text, attachments: [], mentions: [], channelSender: { kind: 'telegram', externalId, name: externalId, role: 'stranger' } } as never);
    await chat('m-1', '2026-10-26T09:00:00.000Z', 'tg-tom-m', 'the oldest one');
    await chat('m-2', '2026-10-26T10:00:00.000Z', 'tg-tom-m', 'second');
    await chat('m-3', '2026-10-26T11:00:00.000Z', 'tg-tom-m', 'third');
    await chat('m-4', '2026-10-26T12:00:00.000Z', 'tg-tom-m', 'x'.repeat(400));
    await chat('m-5', '2026-10-26T12:30:00.000Z', 'tg-someone-else', 'not Tom');

    const text = textOf(await createPersonLookupTool({ memory: portOf(graph, store) }).execute({ name: 'Tom' }, ctxFor(store, owner, 'c-app')));
    const wrote = text.split('\n').filter((line) => line.startsWith('  wrote in'));
    expect(wrote).toHaveLength(3);
    expect(wrote[0]).toBe(`  wrote in "Release crew" on 2026-10-26 12:00 UTC: "${'x'.repeat(300)}…"`);
    expect(wrote[1]).toContain('on 2026-10-26 11:00 UTC: "third"');
    expect(wrote[2]).toContain('on 2026-10-26 10:00 UTC: "second"');
    expect(text).not.toContain('the oldest one');
    expect(text).not.toContain('not Tom');
  });
});

describe('person_lookup: possible matches', () => {
  it('an owner-created Tom with no account is shown with the unlinked Tom from the group, as a possible match, with what he said', async () => {
    const owner = 'owner-tom-' + randomUUID().slice(0, 8);
    const store = await storeFor(owner);
    const { identity, items } = graph.graph;
    await identity.ensureOwner(owner, 'Robin');
    await identity.createPerson(owner, 'Tom');
    const tgTom = await identity.upsertAccount(owner, { platform: 'telegram', externalId: 'tg-tom', name: 'Tom', lastChat: 'Release crew' }, { createPerson: false });
    await items.addItem(owner, { text: "We'll ship the release on Friday.", kind: 'fact', file: 'memory', saidIn: groupKeyOf(owner), audience: groupKeyOf(owner), saidByAccountId: tgTom.account.id, createdAt: AT });
    // The message as the chat stored it: the stored item carries the sender's platform id, not a memory item.
    await store.put('items', { id: 'itm-tom-chat', ownerId: owner, conversationId: 'c-group', at: AT, type: 'user_message', authorId: 'ext-telegram-x', text: "We'll ship the release on Friday.", attachments: [], mentions: [], channelSender: { kind: 'telegram', externalId: 'tg-tom', name: 'Tom', role: 'stranger' } } as never);

    const text = textOf(await createPersonLookupTool({ memory: portOf(graph, store) }).execute({ name: 'Tom' }, ctxFor(store, owner, 'c-app')));
    expect(text).toContain('Tom (per_');
    expect(text).toContain('Possible matches, not confirmed');
    expect(text).toContain('telegram "Tom" (tg-tom), not linked to anyone yet, last seen in "Release crew"');
    expect(text).toContain('remembered: "We\'ll ship the release on Friday." (');
    expect(text).toContain('wrote in "Release crew" on 2026-10-26 10:00 UTC: "We\'ll ship the release on Friday."');
    expect(text).not.toContain('Accounts:');
  });

  it('a group sees no account and no possible match', async () => {
    const owner = 'owner-tom-group-' + randomUUID().slice(0, 8);
    const store = await storeFor(owner);
    const { identity, items } = graph.graph;
    await identity.ensureOwner(owner, 'Robin');
    await identity.createPerson(owner, 'Tom');
    const tgTom = await identity.upsertAccount(owner, { platform: 'telegram', externalId: 'tg-tom-g', name: 'Tom', lastChat: 'Release crew' }, { createPerson: false });
    await items.addItem(owner, { text: "We'll ship the release on Friday.", kind: 'fact', file: 'memory', saidIn: groupKeyOf(owner), audience: groupKeyOf(owner), saidByAccountId: tgTom.account.id, createdAt: AT });

    const text = textOf(await createPersonLookupTool({ memory: portOf(graph, store) }).execute({ name: 'Tom' }, ctxFor(store, owner, 'c-group')));
    expect(text).not.toContain('Possible matches');
    expect(text).not.toContain('tg-tom-g');
  });

  it('an account with the name and no person yet is reported, not an error', async () => {
    const owner = 'owner-lee-' + randomUUID().slice(0, 8);
    const store = await storeFor(owner);
    await graph.graph.identity.ensureOwner(owner, 'Robin');
    await graph.graph.identity.upsertAccount(owner, { platform: 'telegram', externalId: 'tg-lee', name: 'Lee', lastChat: 'Release crew' }, { createPerson: false });

    const reply = await createPersonLookupTool({ memory: portOf(graph, store) }).execute({ name: 'Lee' }, ctxFor(store, owner, 'c-app'));
    expect(reply.isError).toBeUndefined();
    expect(textOf(reply)).toContain('No person is linked to "Lee" yet, but accounts with that name exist.');
    expect(textOf(reply)).toContain('telegram "Lee" (tg-lee)');
  });

  it('a linked account is not a possible match; one filed under another person is, and says which person', async () => {
    const owner = 'owner-priya-acc-' + randomUUID().slice(0, 8);
    const store = await storeFor(owner);
    const { identity } = graph.graph;
    await identity.ensureOwner(owner, 'Robin');
    await identity.upsertAccount(owner, { platform: 'telegram', externalId: 'pr-1', name: 'Priya' }, { createPerson: true });
    await identity.upsertAccount(owner, { platform: 'telegram', externalId: 'pr-2', name: 'Priya' }, { createPerson: false });
    const other = await identity.createPerson(owner, 'Other');
    const filed = await identity.upsertAccount(owner, { platform: 'slack', workspace: 'T9', externalId: 'pr-3', name: 'Priya' }, { createPerson: false });
    await identity.linkAccount(owner, filed.account.id, other.id);

    const text = textOf(await createPersonLookupTool({ memory: portOf(graph, store) }).execute({ name: 'Priya' }, ctxFor(store, owner, 'c-app')));
    expect(text).toContain('Possible matches, not confirmed');
    expect(text).toContain('telegram "Priya" (pr-2), not linked to anyone yet');
    expect(text).toContain('slack "Priya" (pr-3), filed under Other');
    // The linked account is listed once, under Accounts, and never as a possible match.
    expect(text.split('"Priya" (pr-1)')).toHaveLength(2);
  });
});

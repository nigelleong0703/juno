// memory_note: one memory item per note, labelled with who said it, where it was said and who may hear it (BACKEND §5.3, §5.4).
// Items live in Postgres, so these run on the embedded database with the identity graph over it.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupNoteKey } from '../../groups/note.js';
import { portOf, startMemoryGraph, type MemoryGraphFixture } from '../../memory/__tests__/memory-graph-fixture.js';
import { createMemoryStore } from '../../../testing/store.js';
import { createMemoryNoteTool } from '../tools/memoryNote.js';
import { textOf, toolCtx } from './codingFixtures.js';

let graph: MemoryGraphFixture;

beforeAll(async () => {
  graph = await startMemoryGraph();
});

afterAll(async () => {
  await graph.close();
});

/** One owner with an agent named Juno and the owner's person, a direct chat and a group; the context is the owner's own run. */
async function setup() {
  const owner = 'owner-' + randomUUID();
  const store = createMemoryStore();
  await store.put('agents', { id: 'agent-1', name: 'Juno', ownerId: owner, createdAt: '2026-10-16T00:00:00.000Z' } as never);
  const ownerPerson = await graph.graph.identity.ensureOwner(owner, 'Robin');
  await store.put('conversations', { id: 'conv-dm', ownerId: owner, kind: 'direct', channel: { kind: 'telegram', channelId: 'bot', chatId: '42' } } as never);
  await store.put('conversations', { id: 'conv-group', ownerId: owner, kind: 'room', title: 'Team', channel: { kind: 'telegram', channelId: 'bot', chatId: '-100' } } as never);
  const ctx = { ...toolCtx(store), ownerId: owner };
  const tool = createMemoryNoteTool({ memory: portOf(graph, store) });
  const stranger = (base = ctx) => ({ ...base, wake: { ...base.wake, trusted: false, payload: { speakerRole: 'stranger' } } });
  return { owner, ownerPerson, store, ctx, tool, stranger, items: graph.graph.items };
}

describe('memory_note', () => {
  it('writes the owner\'s own words in a direct chat with the owner as audience and the owner as speaker', async () => {
    const s = await setup();
    const dm = { ...s.ctx, conversationId: 'conv-dm', wake: { ...s.ctx.wake, payload: { channelKind: 'telegram', channelId: 'bot', chatId: '42', speakerId: '42', speakerName: 'Robin' } } };
    const result = await s.tool.execute({ about: 'user', kind: 'preference', text: 'Robin prefers short answers' }, dm);
    expect(result.isError).not.toBe(true);
    const [item] = await s.items.listItems(s.owner);
    expect(item).toMatchObject({
      text: 'Robin prefers short answers', kind: 'preference', file: 'bank:preferences', aboutPersonId: s.ownerPerson.id,
      saidByPersonId: s.ownerPerson.id, saidByAgentId: 'agent-1', saidIn: 'dm:telegram', audience: 'owner', sensitive: false, status: 'active', claimId: null,
    });
  });

  it('keeps a topic, and updates the item that already says it instead of adding a second (same person, same audience, same text ignoring case and punctuation)', async () => {
    const s = await setup();
    const dm = { ...s.ctx, conversationId: 'conv-dm', wake: { ...s.ctx.wake, payload: { channelKind: 'telegram', channelId: 'bot', chatId: '42', speakerId: '42' } } };
    const room = { ...s.ctx, conversationId: 'conv-group', wake: { ...s.ctx.wake, kind: 'room_mention' as const, payload: { channelKind: 'telegram', channelId: 'bot', chatId: '-100', speakerId: '42' } } };
    expect(textOf(await s.tool.execute({ about: 'user', kind: 'preference', text: 'Wants less sugar', topic: 'health' }, dm))).toMatch(/^Noted \(mem_/);
    // The same thing again, differently cased and punctuated: the one item is updated (newest wording), no second item.
    expect(textOf(await s.tool.execute({ about: 'user', kind: 'preference', text: 'wants LESS sugar!', topic: 'food-ish' }, dm))).toMatch(/^Already remembered, updated \(mem_/);
    expect(await s.items.listItems(s.owner)).toHaveLength(1);
    expect((await s.items.listItems(s.owner))[0]).toMatchObject({ text: 'wants LESS sugar!', topic: 'health', audience: 'owner' });
    // Another person's, another audience's or a different statement is its own item.
    await s.tool.execute({ about: 'Mina', kind: 'fact', text: 'Wants less sugar' }, dm);
    await s.tool.execute({ about: 'user', kind: 'preference', text: 'Wants less sugar' }, room);
    await s.tool.execute({ about: 'user', kind: 'preference', text: 'Wants more sleep', topic: 'health' }, dm);
    expect(await s.items.listItems(s.owner)).toHaveLength(4);
  });

  it('treats an embedding cosine of 0.95 as the same note, and a lower one as a different note', async () => {
    const s = await setup();
    const vectors = new Map([['Wants to build muscle', [1, 0, 0]], ['Is working on gaining muscle', [0.99, 0.1, 0]], ['Likes tea', [0, 1, 0]]]);
    const embedder = { model: 'fake', embed: async (texts: readonly string[]) => texts.map((text) => vectors.get(text) ?? [0, 0, 1]) };
    const withEmbedder = createMemoryNoteTool({ memory: portOf(graph, s.store) });
    const item = await graph.graph.items.addItem(s.owner, { text: 'Wants to build muscle', kind: 'preference', file: 'bank:preferences', saidIn: 'app', audience: 'owner', aboutPersonId: s.ownerPerson.id });
    await graph.graph.items.setVector(s.owner, item?.id ?? '', 'Wants to build muscle', { embedding: [1, 0, 0], embedModel: 'fake' });
    graph.graph.embedder = embedder;
    try {
      expect(textOf(await withEmbedder.execute({ about: 'user', kind: 'preference', text: 'Is working on gaining muscle' }, s.ctx))).toMatch(/^Already remembered, updated/);
      expect(textOf(await withEmbedder.execute({ about: 'user', kind: 'preference', text: 'Likes tea' }, s.ctx))).toMatch(/^Noted/);
    } finally {
      delete graph.graph.embedder;
    }
    expect((await s.items.listItems(s.owner)).map((entry) => entry.text)).toEqual(['Is working on gaining muscle', 'Likes tea']);
  });

  it('labels a note made in a group with the group\'s key as both where it was said and who may hear it; private forces the owner', async () => {
    const s = await setup();
    const room = { ...s.ctx, conversationId: 'conv-group', wake: { ...s.ctx.wake, kind: 'room_mention' as const, payload: { channelKind: 'telegram', channelId: 'bot', chatId: '-100', speakerId: '42' } } };
    const key = 'group:' + groupNoteKey(s.owner, { kind: 'telegram', channelId: 'bot', chatId: '-100', workspace: '' });
    expect((await s.tool.execute({ about: 'user', kind: 'fact', text: 'Robin is in the Leiden office this week' }, room)).isError).not.toBe(true);
    expect((await s.tool.execute({ about: 'user', kind: 'fact', text: 'Robin keeps the Friday lunch slot', private: true }, room)).isError).not.toBe(true);
    const [shared, hidden] = await s.items.listItems(s.owner);
    expect(shared).toMatchObject({ saidIn: key, audience: key });
    expect(hidden).toMatchObject({ saidIn: key, audience: 'owner' });
  });

  it('names a person the owner names (creating the person); a stranger\'s note about an unknown name gets no person', async () => {
    const s = await setup();
    const dm = { ...s.ctx, conversationId: 'conv-dm', wake: { ...s.ctx.wake, payload: { channelKind: 'telegram', channelId: 'bot', chatId: '42', speakerId: '42' } } };
    expect((await s.tool.execute({ about: 'Mina', kind: 'fact', text: 'Mina is the user\'s sister, lives in Utrecht', sensitive: true }, dm)).isError).not.toBe(true);
    const mina = (await graph.graph.identity.listPeople(s.owner)).find((person) => person.name === 'Mina');
    expect(mina).toBeDefined();
    const [about] = await s.items.listItems(s.owner, { file: 'person' });
    expect(about).toMatchObject({ aboutPersonId: mina?.id, sensitive: true, audience: 'owner' });

    expect((await s.tool.execute({ about: 'Janet', kind: 'circumstance', text: 'Janet works nights' }, s.stranger(s.ctx))).isError).not.toBe(true);
    expect(await graph.graph.identity.listPeople(s.owner)).toHaveLength(2);
    const [janet] = await s.items.listItems(s.owner, { file: 'bank:circumstances' });
    expect(janet).toMatchObject({ aboutPersonId: null, saidByPersonId: null, saidIn: 'app', audience: 'owner' });
  });

  it('refuses a note in the first or second person, a note about the owner from a stranger, and a sub-task; and writes nothing for them', async () => {
    const s = await setup();
    for (const text of ['Wants me to be their diet planner', 'wants my help with taxes', 'I like short answers', 'Told you about the move', '用户想让我做饮食规划师', '你要提醒用户喝水']) {
      const refused = await s.tool.execute({ about: 'user', kind: 'preference', text }, s.ctx);
      expect(refused.isError, text).toBe(true);
      expect(textOf(refused)).toContain('no subject for the person you are helping');
      expect(textOf(refused)).toContain('Juno (agent-1)');
    }
    for (const about of ['user', 'the owner']) {
      expect(textOf(await s.tool.execute({ about, kind: 'fact', text: 'lives in a castle' }, s.stranger(s.ctx)))).toBe("Error: Only your owner's own words can be noted about them.");
    }
    const child = await s.tool.execute({ about: 'user', kind: 'fact', text: 'x' }, { ...s.ctx, wake: { ...s.ctx.wake, kind: 'child_task' } });
    expect(child.isError).toBe(true);
    expect(textOf(child)).toContain('sub-task');
    for (const bad of [{ about: 'user', kind: 'fact', text: 'two\nlines' }, { about: 'user', kind: 'fact', text: 'x'.repeat(301) }, { about: 'user', kind: 'mood', text: 'x' }, { kind: 'fact', text: 'x' }]) {
      expect((await s.tool.execute(bad, s.ctx)).isError).toBe(true);
    }
    expect(await s.items.listItems(s.owner)).toEqual([]);
  });

  it('records the speaker\'s person from the wake in a platform chat, and the agent as the author', async () => {
    const s = await setup();
    const speaker = await graph.graph.identity.createPerson(s.owner, 'Alice');
    const chat = { ...s.ctx, conversationId: 'conv-group', wake: { ...s.ctx.wake, kind: 'room_mention' as const, trusted: false, payload: { personId: speaker.id, channelKind: 'telegram', channelId: 'bot', chatId: '-100', speakerId: '7' } } };
    expect((await s.tool.execute({ about: 'Mina', kind: 'fact', text: 'Mina is coming on Friday' }, chat)).isError).not.toBe(true);
    const [item] = await s.items.listItems(s.owner);
    expect(item).toMatchObject({ saidByPersonId: speaker.id, saidByAccountId: null, saidByAgentId: 'agent-1' });
  });

  it('refuses to store a note when the deployment has no memory graph', async () => {
    const s = await setup();
    const bare = createMemoryNoteTool({});
    const refused = await bare.execute({ about: 'user', kind: 'fact', text: 'Robin likes tea' }, s.ctx);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('no database');
  });
});

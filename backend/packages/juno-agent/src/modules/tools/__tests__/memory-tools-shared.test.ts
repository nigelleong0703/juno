// memory_search / memory_explain read what the people in the run may hear (BACKEND §5.3, batch 5a): the owner alone reads the owner's memory;
// a group reads what that group said and public items; anyone else reads public items only. Without a database they say so.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import { groupNoteKey } from '../../groups/note.js';
import { portOf, startMemoryGraph, type MemoryGraphFixture } from '../../memory/__tests__/memory-graph-fixture.js';
import { createMemoryExplainTool, createMemorySearchTool } from '../tools/memoryTools.js';
import { textOf, toolCtx } from './codingFixtures.js';

const STRANGER = 'ext-discord-0123456789abcdef';
const TELEGRAM = { kind: 'telegram', channelId: 'bot-1', chatId: '-100' };
const GROUP = groupNoteKey('owner', { ...TELEGRAM, workspace: '' });

let graph: MemoryGraphFixture;

beforeAll(async () => {
  graph = await startMemoryGraph();
});

afterAll(async () => {
  await graph.close();
});

async function setup() {
  const store = createMemoryStore();
  await store.put('agents', { id: 'agent-1', name: 'Juno', ownerId: 'owner', createdAt: '2026-10-08T00:00:00.000Z' } as never);
  await store.put('conversations', { id: 'conv-1', kind: 'direct', agentIds: ['agent-1'], memberIds: [], unreadCount: 0, lastItemAt: '2026-10-08T00:00:00.000Z', createdAt: '2026-10-08T00:00:00.000Z' } as never);
  await store.put('conversations', { id: 'conv-group', kind: 'room', title: 'Family', agentIds: ['agent-1'], memberIds: ['owner', 'ext-alice'], unreadCount: 0, lastItemAt: '2026-10-08T00:00:00.000Z', createdAt: '2026-10-08T00:00:00.000Z', channel: TELEGRAM } as never);
  return { store, ctx: toolCtx(store) };
}

/** The run of a person who is not the owner: their message, in the given conversation. */
const asPerson = (ctx: ReturnType<typeof toolCtx>, conversationId: string, id: string) => ({ ...ctx, conversationId, wake: { ...ctx.wake, origin: { type: 'user' as const, id }, trusted: false } });

describe('memory tools for the owner alone', () => {
  it('search and explain the owner\'s memory, with the tag a line carries', async () => {
    const { ctx } = await setup();
    const item = await graph.graph.items.addItem('owner', { text: 'Allergic to peanuts.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner' });
    const search = await createMemorySearchTool({ memory: portOf(graph, ctx.store) }).execute({ query: 'peanuts' }, ctx);
    expect(search.isError).not.toBe(true);
    expect(textOf(search)).toContain('Allergic to peanuts.');
    expect(textOf(search)).toContain('[mem:' + (item?.id ?? '') + ']');
    const explained = textOf(await createMemoryExplainTool({ memory: portOf(graph, ctx.store) }).execute({ tag: '[mem:' + (item?.id ?? '') + ']' }, ctx));
    expect(explained).toContain('Said by');
    expect(explained).toContain('Who may hear it: only the owner.');
  });

  it('memory_explain names the real source of each quote: the user, an assistant\'s log, someone else', async () => {
    const { store, ctx } = await setup();
    const at = '2026-10-23T08:00:00.000Z';
    await store.put('items', { id: 'itm-own', conversationId: 'conv-1', at, type: 'user_message', authorId: 'owner', text: 'I want a diet planner', attachments: [], mentions: [] });
    await store.put('items', { id: 'itm-other', conversationId: 'conv-1', at, type: 'user_message', authorId: STRANGER, text: 'Mina likes tea', attachments: [], mentions: [], channelSender: { kind: 'discord', externalId: 'user-1', name: 'Mina', role: 'stranger' } });
    await store.put('items', { id: 'itm-agent', conversationId: 'conv-1', at, type: 'user_message', authorId: 'ext-discord-fedcba9876543210', text: 'I like Atlas', attachments: [], mentions: [], channelSender: { kind: 'discord', externalId: 'agent:agent-2', name: 'Atlas', role: 'stranger' } });
    await store.put('memoryClaims', { id: 'clm_x', ownerId: 'owner', text: 'The user wants a diet planner.', evidence: [
      { itemId: 'itm-own', quote: 'diet planner' },
      { itemId: 'log:memory/2026-10-23/agent-2.md', quote: 'Wants me to be their diet planner' },
      { itemId: 'itm-other', quote: 'likes tea' },
      { itemId: 'itm-agent', quote: 'like Atlas' },
      { itemId: 'itm-gone', quote: 'old words' },
    ], confidence: 0.9, status: 'active', target: { path: 'MEMORY.md' }, createdAt: at, updatedAt: at } as never);
    await graph.graph.items.addItem('owner', { text: 'The user wants a diet planner.', kind: 'plan', file: 'memory', saidIn: 'app', audience: 'owner', claimId: 'clm_x', createdAt: at });
    const explained = textOf(await createMemoryExplainTool({ memory: portOf(graph, ctx.store) }).execute({ tag: '[claim:clm_x]' }, ctx));
    expect(explained).toContain('- The user said "diet planner" (message itm-own');
    expect(explained).toContain('- An assistant\'s daily-log note says "Wants me to be their diet planner" (/juno/memory/2026-10-23/agent-2.md); that is the assistant\'s wording, not something the user said');
    expect(explained).toContain('- Someone other than the user said "likes tea"');
    expect(explained).toContain('- An assistant said "like Atlas"');
    expect(explained).toContain('- A message said "old words" (message itm-gone is no longer available)');
    expect(explained).not.toContain('The user said "Wants me');
  });
});

describe('memory tools for a group', () => {
  it('search what the group said and public items, never the owner\'s', async () => {
    const { ctx } = await setup();
    const { items } = graph.graph;
    await items.addItem('owner', { text: 'Owner drinks tea every morning.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner' });
    await items.addItem('owner', { text: 'Family says tea is for Sundays.', kind: 'fact', file: 'memory', saidIn: 'group:' + GROUP, audience: 'group:' + GROUP });
    await items.addItem('owner', { text: 'Tea is healthy, public fact.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'public' });
    const search = createMemorySearchTool({ memory: portOf(graph, ctx.store) });
    const found = textOf(await search.execute({ query: 'tea' }, asPerson(ctx, 'conv-group', 'ext-alice')));
    expect(found).toContain('Family says tea is for Sundays.');
    expect(found).toContain('Tea is healthy, public fact.');
    expect(found).not.toContain('Owner drinks tea');
  });

  it('cannot explain the owner\'s own memory by its tag', async () => {
    const { ctx } = await setup();
    const item = await graph.graph.items.addItem('owner', { text: 'Owner has a secret.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner' });
    const refused = await createMemoryExplainTool({ memory: portOf(graph, ctx.store) }).execute({ tag: '[mem:' + (item?.id ?? '') + ']' }, asPerson(ctx, 'conv-group', 'ext-alice'));
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('that you can see here');
  });
});

describe('memory tools for anyone else', () => {
  it('search only public items, and cannot explain the owner\'s', async () => {
    const { ctx } = await setup();
    const item = await graph.graph.items.addItem('owner', { text: 'Owner flies to Oslo.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner' });
    const stranger = asPerson(ctx, 'conv-1', STRANGER);
    const found = textOf(await createMemorySearchTool({ memory: portOf(graph, ctx.store) }).execute({ query: 'Oslo' }, stranger));
    expect(found).toBe('Nothing in memory matches "Oslo".');
    const refused = await createMemoryExplainTool({ memory: portOf(graph, ctx.store) }).execute({ tag: '[mem:' + (item?.id ?? '') + ']' }, stranger);
    expect(refused.isError).toBe(true);
  });
});

describe('without a database', () => {
  it('says that memory is unavailable', async () => {
    const { ctx } = await setup();
    expect(textOf(await createMemorySearchTool().execute({ query: 'peanuts' }, ctx))).toBe('Error: memory is unavailable: this deployment has no database for memory.');
  });
});

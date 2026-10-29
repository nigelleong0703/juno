import { describe, expect, it } from 'vitest';
import type { Store } from '../../contracts/index.js';
import type { Conversation, Item } from '@agent-desktop/public-contracts';
import { conversationActivity, countsAsUnread } from '../conversation-activity.js';
import { emitItemAdded } from '../conversation-activity.js';
import { createMemoryStore } from '../../testing/store.js';

const base = { id: 'itm-1', conversationId: 'cvn-1', at: '2026-10-10T10:00:00.000Z' };

/** The item types the e2e scenario does not exercise; agent_message and user_message are covered there. */
describe('countsAsUnread', () => {
  const cases: Array<[string, Item, boolean]> = [
    ['request', { ...base, type: 'request', requestId: 'req-1' }, true],
    ['artifact', { ...base, type: 'artifact', artifactId: 'lib-1' }, true],
    ['warning notice', { ...base, type: 'system', level: 'warning', text: 'paused' }, true],
    ['error notice', { ...base, type: 'system', level: 'error', text: 'failed' }, true],
    ['info notice', { ...base, type: 'system', level: 'info', text: 'fyi' }, false],
    ['plan', { ...base, type: 'plan', runId: 'run-1', todos: [] }, false],
    ['handoff', { ...base, type: 'handoff', direction: 'to_agent' }, false],
    ['routine', { ...base, type: 'routine', routineId: 'rtn-1', change: 'created' }, false],
    ['run', { ...base, type: 'run', runId: 'run-1' }, false],
  ];
  it.each(cases)('%s -> %s', (_name, item, expected) => {
    expect(countsAsUnread(item)).toBe(expected);
  });
});

describe('conversation last message preview', () => {
  const conversation = { id: 'cvn-1', createdAt: '2026-10-01T00:00:00.000Z' } as Conversation;
  const at = (n: number) => `2026-10-10T10:00:0${n}.000Z`;
  const user = (n: number, text: string, attachments: Array<{ id: string; name: string; kind: 'file' }> = []): Item =>
    ({ ...base, id: `u${n}`, at: at(n), type: 'user_message', authorId: 'usr-1', text, attachments, mentions: [] });
  const agent = (n: number, markdown: string): Item =>
    ({ ...base, id: `a${n}`, at: at(n), type: 'agent_message', agentId: 'agt-1', markdown, citations: [] });
  const request: Item = { ...base, id: 'r', at: at(8), type: 'request', requestId: 'req-1' };
  const plan: Item = { ...base, id: 'p', at: at(9), type: 'plan', runId: 'run-1', todos: [] };
  // newest first, as the store returns them
  const activity = (...items: Item[]) =>
    conversationActivity({ list: async () => ({ items }) } as unknown as Store, conversation);

  it('is the user message, then the agent reply', async () => {
    expect((await activity(user(1, 'hello there'))).lastMessage).toEqual({ text: 'hello there', authorKind: 'user', at: at(1) });
    const reply = await activity(agent(2, 'On it.'), user(1, 'hello there'));
    expect(reply.lastMessagePreview).toBe('On it.');
    expect(reply.lastMessage).toEqual({ text: 'On it.', authorKind: 'agent', agentId: 'agt-1', at: at(2) });
  });

  it('previews a reply, not the message it quotes', async () => {
    expect((await activity(user(3, '> I can research and translate.\n\nhi'))).lastMessagePreview).toBe('hi');
    expect((await activity(user(4, '> only a quote'))).lastMessagePreview).toBe('only a quote');
  });

  it('is not changed by requests or plans, and is absent without a message', async () => {
    expect((await activity(plan, request, agent(2, 'Need a yes.'))).lastMessagePreview).toBe('Need a yes.');
    const none = await activity(plan, request);
    expect(none.lastMessage).toBeUndefined();
    expect(none.lastMessagePreview).toBeUndefined();
  });
});

describe('committed assistant text on the standard wire', () => {
  it('announces the complete reply under its item id, so a standard consumer needs no item.added', async () => {
    const at = '2026-10-29T00:00:00.000Z';
    const store = createMemoryStore();
    const conversation = { id: 'conv-wire', kind: 'direct', agentIds: ['agent-wire'], memberIds: ['owner-wire'], unreadCount: 0, createdAt: at } as unknown as Conversation;
    await store.put('conversations', conversation);
    const item: Item = { id: 'item-wire', conversationId: conversation.id, type: 'agent_message', agentId: 'agent-wire', runId: 'run-wire', markdown: 'Committed reply', citations: [], at };
    await store.put('items', item, { conversationId: conversation.id });
    await emitItemAdded(store, conversation.id, item);
    const events = (await store.eventBus.since(0, 100)).map((row) => row.event);
    const start = events.find((event) => event.type === 'TEXT_MESSAGE_START');
    expect(start).toMatchObject({ messageId: item.id, role: 'assistant', metadata: { juno: { agentId: 'agent-wire', conversationId: conversation.id, runId: 'run-wire' } } });
    expect(events.filter((event) => event.type === 'TEXT_MESSAGE_CONTENT' && event.messageId === item.id).map((event) => event.type === 'TEXT_MESSAGE_CONTENT' ? event.delta : '').join('')).toBe('Committed reply');
    expect(events.some((event) => event.type === 'TEXT_MESSAGE_END' && event.messageId === item.id)).toBe(true);
    expect(events.some((event) => event.type === 'item.added')).toBe(true);
  });
});

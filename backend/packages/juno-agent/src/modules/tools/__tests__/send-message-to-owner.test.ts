// send_message toOwner: a hand-off from a group to the private chat. The note lands in the agent's direct chat with its owner (created
// when there is none), never in the group, and the same agent is woken there once with the owner's original message and the source chat.
// Only the owner's own message may start it; an owner-only chat has nothing to hand over.
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import { wakeEventSchema, type Enqueuer, type Store, type WakeEvent } from '../../../contracts/index.js';
import { createSendMessageTool } from '../tools/sendMessage.js';
import { textOf, toolCtx } from './codingFixtures.js';

const AT = '2026-10-22T00:00:00.000Z';
const room = { id: 'conv-1', kind: 'room', title: '#general · Slack', agentIds: ['agent-1'], memberIds: ['owner', 'bob'], unreadCount: 0, lastItemAt: AT, createdAt: AT, ownerId: 'owner' } as const;
const direct = { id: 'cvn-direct', kind: 'direct', agentIds: ['agent-1'], memberIds: ['owner'], unreadCount: 0, lastItemAt: AT, createdAt: AT, ownerId: 'owner' } as const;

const wakeBy = (origin: WakeEvent['origin'], trusted: boolean) => wakeEventSchema.parse({
  id: 'wk-1', ownerId: 'owner', agentId: 'agent-1', sessionKey: 'agent-1:conv-1', conversationId: 'conv-1',
  kind: 'room_mention', origin, trusted, priority: 'user', payload: { text: 'Nova, what time is my flight tomorrow?' }, at: AT,
});

class RecordingEnqueuer implements Enqueuer {
  wakes: WakeEvent[] = [];
  async enqueue(event: WakeEvent) { this.wakes.push(event); return { accepted: true }; }
  async stopRun() {}
  async resolveAwakeable() {}
  async scheduleRoutine() {}
}

async function setup(withDirect: boolean, wake = wakeBy({ type: 'user' }, true)) {
  const store = createMemoryStore();
  await store.put('agents', { id: 'agent-1', name: 'Nova', ownerId: 'owner', createdBy: 'owner' } as never);
  await store.put('conversations', room as never);
  if (withDirect) await store.put('conversations', direct as never);
  const enqueuer = new RecordingEnqueuer();
  const tool = createSendMessageTool({ store, enqueuer });
  return { store, tool, enqueuer, ctx: { ...toolCtx(store), enqueuer, wake } };
}

const messagesIn = async (store: Store, conversationId: string) =>
  (await store.list('items', { where: { conversationId }, limit: 20 })).items.filter((item) => item.type === 'agent_message');

describe('send_message toOwner', () => {
  it('posts the note in the owner\'s direct chat, not in the group, and wakes the agent there once with the original question and source chat', async () => {
    const { store, tool, enqueuer, ctx } = await setup(true);
    const result = await tool.execute({ kind: 'text', text: 'On it, checking your flight', toOwner: true }, ctx);
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain("you'll answer privately");
    expect(await messagesIn(store, 'conv-1')).toHaveLength(0);
    const [item] = await messagesIn(store, 'cvn-direct');
    expect(item).toMatchObject({ type: 'agent_message', agentId: 'agent-1', markdown: 'On it, checking your flight' });
    expect(item).not.toHaveProperty('replyTo');
    // The group's final reply is not suppressed by the private note.
    expect(result.details).toMatchObject({ deliveredText: 'On it, checking your flight', deliveredConversationId: 'cvn-direct' });
    expect(enqueuer.wakes).toHaveLength(1);
    expect(enqueuer.wakes[0]).toMatchObject({
      agentId: 'agent-1', ownerId: 'owner', conversationId: 'cvn-direct', sessionKey: 'agent-1:cvn-direct', kind: 'private_handoff',
      origin: { type: 'system' }, trusted: true,
      payload: { text: 'Nova, what time is my flight tomorrow?', note: 'On it, checking your flight', sourceChat: '#general · Slack', sourceConversationId: 'conv-1' },
    });
  });

  it('creates the direct chat when the owner has none yet, and wakes the agent in it', async () => {
    const { store, tool, enqueuer, ctx } = await setup(false);
    await tool.execute({ kind: 'text', text: 'Here is the number', toOwner: true }, ctx);
    const chats = (await store.list('conversations', { limit: 20 })).items.filter((chat) => chat.kind === 'direct');
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ agentIds: ['agent-1'], memberIds: ['owner'], ownerId: 'owner' });
    expect(await messagesIn(store, chats[0]?.id ?? '')).toHaveLength(1);
    expect(await messagesIn(store, 'conv-1')).toHaveLength(0);
    expect(enqueuer.wakes.map((wake) => wake.conversationId)).toEqual([chats[0]?.id]);
  });

  it('is refused when a stranger\'s message started the run: nothing is sent and nothing is woken', async () => {
    for (const wake of [wakeBy({ type: 'user' }, false), wakeBy({ type: 'user', id: 'bob' }, true), wakeBy({ type: 'agent', id: 'agent-2' }, false)]) {
      const { store, tool, enqueuer, ctx } = await setup(true, wake);
      const result = await tool.execute({ kind: 'text', text: 'x', toOwner: true }, ctx);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('only for a message from your owner');
      expect(await messagesIn(store, 'cvn-direct')).toHaveLength(0);
      expect(enqueuer.wakes).toHaveLength(0);
    }
  });

  it('is refused in a chat that is already private to the owner', async () => {
    const { store, tool, enqueuer, ctx } = await setup(true);
    const result = await tool.execute({ kind: 'text', text: 'x', toOwner: true }, { ...ctx, conversationId: 'cvn-direct', wake: { ...ctx.wake, conversationId: 'cvn-direct' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('already private');
    expect(await messagesIn(store, 'cvn-direct')).toHaveLength(0);
    expect(enqueuer.wakes).toHaveLength(0);
  });

  it('a message without toOwner still stays in the current conversation', async () => {
    const { store, tool, enqueuer, ctx } = await setup(true);
    await tool.execute({ kind: 'text', text: 'Hello group' }, ctx);
    expect(await messagesIn(store, 'conv-1')).toHaveLength(1);
    expect(await messagesIn(store, 'cvn-direct')).toHaveLength(0);
    expect(enqueuer.wakes).toHaveLength(0);
  });

  it('is for a plain message: not with a room or targets, not for a question', async () => {
    const { store, tool, enqueuer, ctx } = await setup(true);
    expect((await tool.execute({ kind: 'text', text: 'x', toOwner: true, conversationId: 'other' }, ctx)).isError).toBe(true);
    expect((await tool.execute({ kind: 'text', text: 'x', toOwner: true, targetAgentIds: ['agent-2'] }, ctx)).isError).toBe(true);
    expect(textOf(await tool.execute({ kind: 'question', toOwner: true }, ctx))).toContain('toOwner');
    expect(await messagesIn(store, 'cvn-direct')).toHaveLength(0);
    expect(enqueuer.wakes).toHaveLength(0);
  });
});

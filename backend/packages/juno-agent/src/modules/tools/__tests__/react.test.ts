// react: only the owner's own message in a direct chat takes a reaction; a stranger's message (stored under a synthetic author id) does not.
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import { createReactTool } from '../tools/react.js';
import type { ChannelCallResult, ChannelPort } from '../tools/channelHistory.js';
import { textOf, toolCtx } from './codingFixtures.js';

const AT = '2026-10-08T00:00:00.000Z';

async function setup(authorId: string) {
  const store = createMemoryStore();
  await store.put('conversations', { id: 'conv-1', kind: 'direct', agentIds: ['agent-1'], memberIds: [], unreadCount: 0, lastItemAt: AT, createdAt: AT } as never);
  await store.put('items', { id: 'itm-1', conversationId: 'conv-1', type: 'user_message', at: AT, authorId, text: 'hi', attachments: [], mentions: [] }, { conversationId: 'conv-1' });
  const ctx = toolCtx(store);
  return { store, ctx: { ...ctx, wake: { ...ctx.wake, payload: { itemId: 'itm-1' } } } };
}

describe('react', () => {
  it('reacts to the owner\'s message', async () => {
    const { store, ctx } = await setup('owner');
    expect(textOf(await createReactTool().execute({ emoji: '👍' }, ctx))).toBe('Reacted with 👍.');
    expect(await store.get('items', 'itm-1')).toMatchObject({ reaction: '👍' });
  });

  describe('in a platform chat', () => {
    type ReactInput = Parameters<ChannelPort['react']>[0];
    const platformCtx = (kind: string, externalMessageId: string) => {
      const ctx = toolCtx(createMemoryStore());
      return { ...ctx, wake: { ...ctx.wake, kind: 'room_mention' as const, trusted: false, payload: { text: 'hi', channelKind: kind, channelId: 'chan-1', chatId: 'chat-1', externalMessageId } } };
    };
    const portAnswering = (answer: ChannelCallResult) => {
      const asked: ReactInput[] = [];
      const port: ChannelPort = { react: async (input) => { asked.push(input); return answer; }, history: async () => ({ status: 'unsupported' }) };
      return { port, asked };
    };

    it('reacts to the message that woke the run, through the platform', async () => {
      const { port, asked } = portAnswering({ status: 'ok', value: {} });
      expect(textOf(await createReactTool(port).execute({ emoji: '👍' }, platformCtx('discord', 'M7')))).toBe('Reacted with 👍.');
      expect(asked).toEqual([{ ownerId: 'owner', origin: expect.objectContaining({ kind: 'discord', channelId: 'chan-1', chatId: 'chat-1' }), messageId: 'M7', emoji: '👍' }]);
      // Slack and Telegram ids carry the chat in front.
      await createReactTool(port).execute({ emoji: '👍' }, platformCtx('slack', 'chat-1:1700000000.000100'));
      expect(asked[1]?.messageId).toBe('1700000000.000100');
    });

    it('does not call the platform for an emoji outside its list, and says which ones it has', async () => {
      const { port, asked } = portAnswering({ status: 'ok', value: {} });
      const out = await createReactTool(port).execute({ emoji: '🦄' }, platformCtx('telegram', 'chat-1:5'));
      expect(out.isError).toBeUndefined();
      expect(textOf(out)).toContain('not available on this platform; nothing was reacted. It has: 👍');
      expect(asked).toHaveLength(0);
    });

    it('says "not available here" where the platform has no reactions (Feishu without the permission) or the host has no port', async () => {
      const { port, asked } = portAnswering({ status: 'ok', value: {} });
      expect(textOf(await createReactTool(port).execute({ emoji: '👍' }, platformCtx('feishu', 'om_1')))).toBe('Reactions are not available here.');
      expect(textOf(await createReactTool().execute({ emoji: '👍' }, platformCtx('discord', 'M1')))).toBe('Reactions are not available here.');
      expect(asked).toHaveLength(0);
    });

    it('turns what the platform answers into a plain result: unsupported and skipped are not errors, a failure is', async () => {
      const ctx = platformCtx('discord', 'M1');
      expect(textOf(await createReactTool(portAnswering({ status: 'unsupported' }).port).execute({ emoji: '👍' }, ctx))).toBe('Reactions are not available here.');
      const skipped = await createReactTool(portAnswering({ status: 'skipped', reason: 'Discord has no 👍 reaction' }).port).execute({ emoji: '👍' }, ctx);
      expect([skipped.isError, textOf(skipped)]).toEqual([undefined, 'Discord has no 👍 reaction; nothing was reacted.']);
      const failed = await createReactTool(portAnswering({ status: 'failed', error: 'Discord reaction failed: Missing Permissions' }).port).execute({ emoji: '👍' }, ctx);
      expect([failed.isError, textOf(failed)]).toEqual([true, 'Error: Discord reaction failed: Missing Permissions']);
    });
  });

  it('refuses a message someone else wrote', async () => {
    const { store, ctx } = await setup('ext-telegram-0123456789abcdef');
    const refused = await createReactTool().execute({ emoji: '👍' }, ctx);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("owner's own message");
    expect(await store.get('items', 'itm-1')).not.toHaveProperty('reaction');
  });
});

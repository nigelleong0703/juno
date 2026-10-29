// react: the agent puts one emoji on the user's message that woke this run (Muse does this as one of its first actions).
// The message is the wake's own, never a model-supplied id. In the app only a direct chat and the owner's own message take a
// reaction; in a platform chat it goes on the platform message that woke the run, through the platform adapter, where the chat's
// capability row (public-contracts) allows it.
import { chatCapabilities, reactionAllowed } from '@agent-desktop/public-contracts';
import { z } from 'zod';
import { isRoutineWake, type Tool, type ToolContext, type ToolResult } from '../../../contracts/index.js';
import { channelGrants, replyOriginOf, wakeMessageId } from '../../channel-origin.js';
import type { ChannelPort } from './channelHistory.js';

const schema = z.object({ emoji: z.string().trim() });
const segmenter = new Intl.Segmenter();

/** One grapheme (a flag or a skin-toned emoji is one) that is an emoji. */
const isSingleEmoji = (text: string): boolean => text.length <= 16 && [...segmenter.segment(text)].length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|^[0-9#*]️?⃣$/u.test(text);

const result = (text: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: isError ? 'Error: ' + text : text }], ...(isError ? { isError } : {}) });
const NOT_AVAILABLE = 'Reactions are not available here.';

/** The platform path: the message that woke this run, in the platform chat it came from. Not-available answers are plain text, not errors. */
async function reactOnPlatform(port: ChannelPort | undefined, ctx: ToolContext, emoji: string): Promise<ToolResult> {
  const origin = replyOriginOf([ctx.wake]);
  const messageId = wakeMessageId(ctx.wake);
  if (origin === undefined || messageId === undefined) return result('there is no platform message to react to in this run.', true);
  const reactions = chatCapabilities(origin.kind, await channelGrants(ctx.store, origin)).reactions;
  if (reactions.mode === 'none' || port === undefined) return result(NOT_AVAILABLE);
  if (!reactionAllowed(reactions, emoji)) return result(`That emoji is not available on this platform; nothing was reacted. It has: ${(reactions.allowed ?? []).join(' ')}`);
  return ctx.step('react', async (): Promise<ToolResult> => {
    const outcome = await port.react({ ownerId: ctx.ownerId, origin, messageId, emoji });
    if (outcome.status === 'ok') return result('Reacted with ' + emoji + '.');
    if (outcome.status === 'unsupported') return result(NOT_AVAILABLE);
    return outcome.status === 'skipped' ? result(outcome.reason + '; nothing was reacted.') : result(outcome.error, true);
  });
}

export function createReactTool(port?: ChannelPort): Tool {
  return {
    name: 'react',
    description: '',
    parameters: { type: 'object', properties: { emoji: { type: 'string', description: '' } }, required: ['emoji'], additionalProperties: false },
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.safeParse(args);
      if (!parsed.success || !isSingleEmoji(parsed.data.emoji)) return result('"emoji" must be a single emoji.', true);
      if (ctx.wake.origin.type === 'user' && replyOriginOf([ctx.wake]) !== undefined) return reactOnPlatform(port, ctx, parsed.data.emoji);
      const itemId = ctx.wake.payload.itemId;
      if (ctx.wake.kind !== 'user_message' || ctx.wake.origin.type !== 'user' || isRoutineWake(ctx.wake) || typeof itemId !== 'string') {
        return result('there is no user message to react to in this run.', true);
      }
      return ctx.step('react', async (): Promise<ToolResult> => {
        const [conversation, item] = await Promise.all([ctx.store.get('conversations', ctx.conversationId), ctx.store.get('items', itemId)]);
        if (conversation?.kind !== 'direct' || item?.type !== 'user_message' || item.conversationId !== ctx.conversationId || item.authorId !== ctx.ownerId) {
          return result('reactions only work on the owner\'s own message in a direct chat.', true);
        }
        const next = await ctx.store.patch('items', itemId, { reaction: parsed.data.emoji });
        await ctx.store.emit({ type: 'item.added', conversationId: ctx.conversationId, item: next });
        return result('Reacted with ' + parsed.data.emoji + '.');
      });
    },
  };
}

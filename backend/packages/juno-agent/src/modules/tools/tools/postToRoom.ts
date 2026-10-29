/**
 * post_to_room: validated room posting with truthful queue reporting.
 *
 * The room, sender membership and every mention are revalidated at execution
 * time before any write (including the hop-depth fence); non-members are
 * never joined implicitly and mention ids are deduped. Mention queueing is
 * not atomic with the stored post: a partial outcome names the agents whose
 * wake was not queued instead of claiming full delivery. Accepted only means
 * the wake reached ingress, never that it was read or answered.
 */
import { z } from 'zod';
import type { Enqueuer, Store, Tool, ToolContext, ToolResult, WakeEvent } from '../../../contracts/index.js';
import { wakeEventSchema } from '../../../contracts/index.js';
import { newId, nowIso } from '../util.js';
import { peerSenderPayload, requireRequesterContext, validateRoomAction } from './relationPolicy.js';
import { emitItemAdded } from '../../../execution/conversation-activity.js';

const postToRoomSchema = z.object({
  roomId: z.string(),
  message: z.string(),
  mentions: z.array(z.string()).optional(),
});

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function createPostToRoomTool(opts: { store: Store; enqueuer: Enqueuer }): Tool {
  return {
    name: 'post_to_room',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        roomId: { type: 'string' },
        message: { type: 'string' },
        mentions: { type: 'array', items: { type: 'string' } },
      },
      required: ['roomId', 'message'],
    },
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = postToRoomSchema.parse(args);
      const roomId = parsed.roomId;
      const message = parsed.message;
      if (!roomId) return errorResult('Error: roomId required');
      if (message.length === 0) return errorResult('Error: message text required');
      const mentions = parsed.mentions ?? [];
      if (mentions.includes(ctx.agentId)) return errorResult('Error: an agent cannot target itself; nothing was posted.');
      const auth = await requireRequesterContext(ctx);
      if (!auth.ok) return errorResult(auth.error);
      const roomCheck = await validateRoomAction(ctx, auth.value, roomId, mentions, 'posted');
      if (!roomCheck.ok) return errorResult(roomCheck.error);
      const item = {
        id: newId('itm'),
        conversationId: roomId,
        type: 'agent_message' as const,
        agentId: ctx.agentId,
        markdown: message,
        citations: [],
        at: nowIso(),
      };
      try {
        await ctx.step('post_to_room', async () => {
          await opts.store.put('items', item, { conversationId: roomId });
          await emitItemAdded(opts.store, roomId, item);
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return errorResult('Error: the room post could not be stored: ' + msg);
      }
      const currentHop = ctx.wake.hop?.depth ?? 0;
      const failed: string[] = [];
      const sender = await peerSenderPayload(opts.store, ctx.agentId, { conversationId: ctx.conversationId, wake: ctx.wake });
      for (const mentionedAgentId of mentions) {
        const queued = await queueMention(opts.enqueuer, ctx, mentionedAgentId, roomId, message, currentHop, sender);
        if (!queued.accepted) failed.push(mentionedAgentId + (queued.reason === undefined ? '' : ' (' + queued.reason + ')'));
      }
      if (failed.length > 0) {
        return {
          content: [{ type: 'text', text: 'Posted to room ' + roomId + ' but the mention wake was not queued for: ' + failed.join(', ') }],
          isError: true,
        };
      }
      const suffix = mentions.length > 0 ? ' (mention queued for ' + String(mentions.length) + ' agent(s))' : '';
      return { content: [{ type: 'text', text: 'Posted to room ' + roomId + suffix }] };
    },
  };
}

async function queueMention(
  enqueuer: Enqueuer,
  ctx: ToolContext,
  mentionedAgentId: string,
  roomId: string,
  message: string,
  currentHop: number,
  sender: Record<string, string | boolean>,
): Promise<{ accepted: boolean; reason?: string }> {
  const wakeEvent = buildMentionWake(ctx, mentionedAgentId, roomId, message, currentHop, sender);
  try {
    wakeEventSchema.parse(wakeEvent);
  } catch {
    return { accepted: false, reason: 'invalid wake event' };
  }
  try {
    return await enqueuer.enqueue(wakeEvent, { awaitDecision: true });
  } catch (error) {
    return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function buildMentionWake(ctx: ToolContext, agentId: string, roomId: string, message: string, currentHop: number, sender: Record<string, string | boolean>): WakeEvent {
  return {
    id: newId('wke'),
    ownerId: ctx.ownerId,
    agentId,
    sessionKey: agentId + ':' + roomId,
    conversationId: roomId,
    kind: 'room_mention',
    origin: { type: 'agent', id: ctx.agentId },
    trusted: false,
    priority: 'peer',
    payload: { text: message, ...sender },
    hop: { chainId: ctx.wake.hop?.chainId ?? newId('chain'), depth: currentHop + 1 },
    at: nowIso(),
    status: 'accepted',
  };
}

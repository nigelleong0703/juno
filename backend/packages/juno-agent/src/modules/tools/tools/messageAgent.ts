/**
 * message_agent: validated agent-to-agent delivery, only inside a room the user is in.
 *
 * The message is posted in the current room (visible to the user) and wakes only the resolved
 * target there; the room path revalidates membership of the user, the sender and the target before
 * any write. Anywhere else (a direct chat, an unreadable or missing conversation) it is refused
 * before any read of the target, write or enqueue: agents never talk privately when the user is
 * not in the conversation. replay is 'never' (like the other write tools): a crash mid-call must
 * surface as interrupted, never silently re-execute. The enqueue receipt only means the wake
 * reached ingress; results say queued, never delivered. Routing keeps the Session agent:conversation key.
 */
import { z } from 'zod';
import type { Enqueuer, Store, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { LIMITS } from '../../../contracts/index.js';
import { deliverRoomText } from './roomDelivery.js';
import { peerSenderPayload, readString } from './relationPolicy.js';
import type { MemoryPort } from '../../memory/port.js';
import { handoffMemory, MAX_MEMORY_REFS, memoryNote, receiverRun, withHandoffMemory } from '../../memory/handoff.js';

const messageAgentSchema = z.object({
  target: z.string(),
  message: z.string(),
  memoryRefs: z.array(z.string().min(1).max(64)).max(MAX_MEMORY_REFS).optional(),
});

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function createMessageAgentTool(opts: { store: Store; enqueuer: Enqueuer; memory?: MemoryPort }): Tool {
  return {
    name: 'message_agent',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        message: { type: 'string' },
        memoryRefs: { type: 'array', items: { type: 'string' }, maxItems: MAX_MEMORY_REFS, description: '' },
      },
      required: ['target', 'message'],
    },
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = messageAgentSchema.parse(args);
      const targetId = parsed.target;
      if (!targetId) return errorResult('Error: target agent ID required');
      if (parsed.message.length === 0) return errorResult('Error: message text required');
      if (targetId === ctx.agentId) return errorResult('Error: an agent cannot message itself');
      const currentHop = ctx.wake.hop?.depth ?? 0;
      if (currentHop >= LIMITS.chain.maxHopDepth) {
        return errorResult(
          'Error: message depth exceeds limit (' + String(currentHop) + ' >= ' + String(LIMITS.chain.maxHopDepth) + '). Agent-to-agent message loops are blocked.',
        );
      }
      // Only a room (the user is a member; deliverRoomText revalidates that) may carry agent-to-agent
      // messages. An unreadable or missing current conversation fails closed like any other non-room.
      let current: unknown;
      try {
        current = await opts.store.get('conversations', ctx.conversationId);
      } catch {
        return errorResult('Error: the current conversation record is unreadable; nothing was queued.');
      }
      if (readString(current, 'kind') !== 'room') {
        return errorResult('Error: agents may only message each other inside a room the user is in, and this conversation is not one. Create a room with conversation_create and then use send_message with that room\'s conversationId and targetAgentIds, or give the work to a sub-task with child_spawn; nothing was queued.');
      }
      const sender = await peerSenderPayload(opts.store, ctx.agentId, { conversationId: ctx.conversationId, wake: ctx.wake });
      const memory = await handoffMemory(opts.store, opts.memory, {
        ownerId: ctx.ownerId,
        sender: { ownerId: ctx.ownerId, agentId: ctx.agentId, conversationId: ctx.conversationId, wake: [ctx.wake] },
        receiver: receiverRun({ ownerId: ctx.ownerId, agentId: targetId, conversationId: ctx.conversationId, kind: 'room_mention', senderAgentId: ctx.agentId, payload: sender }),
        refs: parsed.memoryRefs ?? [],
      });
      // The memory rides in the target's wake only: the posted text is what the room reads.
      const delivered = await deliverRoomText(opts, ctx, ctx.conversationId, parsed.message, [targetId], withHandoffMemory(parsed.message, memory.lines));
      if (!delivered.ok) return delivered.result;
      return {
        content: [{ type: 'text', text: 'Message posted in room ' + ctx.conversationId + ' mentioning agent ' + targetId + memoryNote(memory) }],
        details: {
          deliveredText: delivered.value.markdown,
          deliveredConversationId: delivered.value.roomId,
          roomDelivery: { roomId: delivered.value.roomId, targets: delivered.value.queued },
        },
      };
    },
  };
}

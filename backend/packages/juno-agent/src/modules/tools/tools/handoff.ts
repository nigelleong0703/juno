/**
 * handoff: validated task transfer with queue propagation.
 *
 * The room, sender membership and handoff target are revalidated before any
 * write (including the hop-depth fence). The enqueue receipt is part of the
 * result: a refused or failed wake is reported as a partial outcome (note
 * stored, wake not queued), never as a completed handoff. Accepted only
 * means the wake reached ingress. (E17: the old step callback swallowed this.)
 */
import { z } from 'zod';
import type { Enqueuer, Store, Tool, ToolContext, ToolResult, WakeEvent } from '../../../contracts/index.js';
import { wakeEventSchema } from '../../../contracts/index.js';
import { newId, nowIso } from '../util.js';
import { peerSenderPayload, requireRequesterContext, validateRoomAction } from './relationPolicy.js';
import type { MemoryPort } from '../../memory/port.js';
import { handoffMemory, MAX_MEMORY_REFS, memoryNote, receiverRun, withHandoffMemory } from '../../memory/handoff.js';

const handoffSchema = z.object({
  roomId: z.string(),
  to: z.string(),
  task: z.string(),
  memoryRefs: z.array(z.string().min(1).max(64)).max(MAX_MEMORY_REFS).optional(),
});

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function createHandoffTool(opts: { store: Store; enqueuer: Enqueuer; memory?: MemoryPort }): Tool {
  return {
    name: 'handoff',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        roomId: { type: 'string' },
        to: { type: 'string' },
        task: { type: 'string' },
        memoryRefs: { type: 'array', items: { type: 'string' }, maxItems: MAX_MEMORY_REFS, description: '' },
      },
      required: ['roomId', 'to', 'task'],
    },
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = handoffSchema.parse(args);
      const roomId = parsed.roomId;
      const to = parsed.to;
      const task = parsed.task;
      if (!roomId || !to) return errorResult('Error: roomId and to agent ID required');
      if (task.length === 0) return errorResult('Error: task text required');
      const auth = await requireRequesterContext(ctx);
      if (!auth.ok) return errorResult(auth.error);
      const roomCheck = await validateRoomAction(ctx, auth.value, roomId, [to], 'handed off');
      if (!roomCheck.ok) return errorResult(roomCheck.error);
      const item = {
        id: newId('itm'),
        conversationId: roomId,
        type: 'handoff' as const,
        agentId: ctx.agentId,
        toAgentId: to,
        direction: 'to_agent' as const,
        at: nowIso(),
      };
      const currentHop = ctx.wake.hop?.depth ?? 0;
      const sender = await peerSenderPayload(opts.store, ctx.agentId, { conversationId: ctx.conversationId, wake: ctx.wake });
      const memory = await handoffMemory(opts.store, opts.memory, {
        ownerId: ctx.ownerId,
        sender: { ownerId: ctx.ownerId, agentId: ctx.agentId, conversationId: ctx.conversationId, wake: [ctx.wake] },
        receiver: receiverRun({ ownerId: ctx.ownerId, agentId: to, conversationId: roomId, kind: 'room_mention', senderAgentId: ctx.agentId, payload: sender }),
        refs: parsed.memoryRefs ?? [],
      });
      const wakeEvent = buildHandoffWake(ctx, to, roomId, withHandoffMemory(task, memory.lines), currentHop, sender);
      try {
        wakeEventSchema.parse(wakeEvent);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return errorResult('Error: invalid handoff wake event: ' + msg + '; nothing was handed off.');
      }
      try {
        await ctx.step('handoff', async () => {
          await opts.store.put('items', item, { conversationId: roomId });
          await opts.store.emit({ type: 'item.added', conversationId: roomId, item });
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return errorResult('Error: the handoff note could not be stored: ' + msg);
      }
      let accepted: boolean;
      let reason: string | undefined;
      try {
        const receipt = await opts.enqueuer.enqueue(wakeEvent, { awaitDecision: true });
        accepted = receipt.accepted;
        reason = receipt.reason;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return errorResult('Error: the handoff note is stored in room ' + roomId + ' but the wake for ' + to + ' was not queued: ' + msg);
      }
      if (!accepted) {
        const suffix = reason !== undefined ? ': ' + reason : '';
        return errorResult('Error: handoff not delivered to ' + to + '; the note is stored in room ' + roomId + ' but the wake was not queued' + suffix);
      }
      return { content: [{ type: 'text', text: 'Handoff to ' + to + ' queued: ' + task + ' (note stored in room ' + roomId + ')' + memoryNote(memory) }] };
    },
  };
}

function buildHandoffWake(ctx: ToolContext, to: string, roomId: string, task: string, currentHop: number, sender: Record<string, string | boolean>): WakeEvent {
  return {
    id: newId('wke'),
    ownerId: ctx.ownerId,
    agentId: to,
    sessionKey: to + ':' + roomId,
    conversationId: roomId,
    kind: 'room_mention',
    origin: { type: 'agent', id: ctx.agentId },
    trusted: false,
    priority: 'peer',
    payload: { text: task, ...sender },
    hop: { chainId: ctx.wake.hop?.chainId ?? newId('chain'), depth: currentHop + 1 },
    at: nowIso(),
    status: 'accepted',
  };
}

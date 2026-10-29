/**
 * Shared room delivery for model tools (GC2).
 *
 * One validated path persists a visible message in the CURRENT room and wakes
 * only the explicitly resolved target ids in that same room. Permissions are
 * checked before any write; wakes derive from validated ids, never from
 * parsed @names in text. The stored item uses only agent_message
 * schema fields; visible mentions are canonical display-name lines in the
 * markdown body (plain text, no parser reliance).
 */
import type { Enqueuer, Store, ToolContext, ToolResult, WakeEvent } from '../../../contracts/index.js';
import { CHILD_BOUNDARY_REFUSAL, isChildRun } from '../../tasks/childDelivery.js';
import { wakeEventSchema } from '../../../contracts/index.js';
import { newId, nowIso } from '../util.js';
import { peerSenderPayload, readString, requireRequesterContext, validateRoomAction } from './relationPolicy.js';
import { emitItemAdded } from '../../../execution/conversation-activity.js';

export interface RoomDelivery {
  roomId: string;
  markdown: string;
  queued: string[];
}

function errorResult(text: string, details?: Record<string, unknown>): ToolResult {
  const result: ToolResult = { content: [{ type: 'text', text }], isError: true };
  if (details !== undefined) result.details = details;
  return result;
}

/** Canonical display label from the stored agent record (backend-known, not model-inferred). */
export function roomLabel(agent: unknown, fallbackId: string): string {
  const name = readString(agent, 'name');
  if (name !== undefined) return name;
  const handle = readString(agent, 'handle');
  if (handle !== undefined) return handle;
  return fallbackId;
}

/** Render visible mentions as plain @lines; deduped so repeated ids show once. */
export function renderRoomMentions(body: string, labels: string[]): string {
  const tokens: string[] = [];
  for (const label of labels) {
    const token = '@' + escapeRoomLabel(label);
    if (!tokens.includes(token)) tokens.push(token);
  }
  if (tokens.length === 0) return body;
  return body + '\n\n' + tokens.join(' ');
}

/** Escape newlines and markdown controls in a stored label so a crafted name cannot inject formatting or links. */
export function escapeRoomLabel(label: string): string {
  const flat = label.replace(/[\n\r]+/g, ' ');
  return flat.replace(/([\\`*_{}[\]()#+.!|>~-])/g, '\\$1');
}

/**
 * Post `message` in the room and wake each target there. `wakeText`, when given, is what the targets' wakes carry instead of the
 * posted text (the posted text stays what the people in the room read: a handed-over memory block goes to the wake only).
 */
export async function deliverRoomText(
  opts: { store: Store; enqueuer: Enqueuer },
  ctx: ToolContext,
  roomId: string,
  message: string,
  targetIds: string[],
  wakeText?: string,
): Promise<{ ok: true; value: RoomDelivery } | { ok: false; result: ToolResult }> {
  if (message.length === 0) return { ok: false, result: errorResult('Error: message text required') };
  // CT: a child run is silent; room or peer delivery is refused before any validation or write.
  if (isChildRun(await opts.store.get('runs', ctx.runId))) return { ok: false, result: errorResult(CHILD_BOUNDARY_REFUSAL) };
  const deduped = [...new Set(targetIds.filter((id) => id.length > 0))];
  const others = deduped.filter((id) => id !== ctx.agentId);
  // A plain room message is allowed (no targets). A non-empty list that reduces to
  // nothing after dropping self is a self-wake attempt and rejected before any write.
  if (deduped.length > 0 && others.length === 0) {
    return { ok: false, result: errorResult('Error: an agent cannot target itself; nothing was posted.') };
  }
  const auth = await requireRequesterContext(ctx);
  if (!auth.ok) return { ok: false, result: errorResult(auth.error) };
  const roomCheck = await validateRoomAction(ctx, auth.value, roomId, others, 'posted');
  if (!roomCheck.ok) return { ok: false, result: errorResult(roomCheck.error) };
  const labels: string[] = [];
  for (const id of others) {
    const doc = await opts.store.get('agents', id);
    if (doc === null) return { ok: false, result: errorResult('Error: the target agent record is unreadable; nothing was posted.') };
    const display = readString(doc, 'name') ?? readString(doc, 'handle');
    if (display === undefined) return { ok: false, result: errorResult('Error: a target agent has no displayable name; nothing was posted.') };
    labels.push(display);
  }
  const markdown = renderRoomMentions(message, labels);
  const item = {
    id: newId('itm'),
    conversationId: roomId,
    type: 'agent_message' as const,
    agentId: ctx.agentId,
    runId: ctx.runId,
    markdown,
    citations: [],
    at: nowIso(),
  };
  try {
    await ctx.step('room_delivery_post', async () => {
      await opts.store.put('items', item, { conversationId: roomId, runId: ctx.runId });
      await emitItemAdded(opts.store, roomId, item);
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, result: errorResult('Error: the room message could not be stored: ' + detail) };
  }
  const failed: string[] = [];
  const reasons: string[] = [];
  const sender = await peerSenderPayload(opts.store, ctx.agentId, { conversationId: ctx.conversationId, wake: ctx.wake });
  for (const id of others) {
    const queued = await queueRoomMention(opts.enqueuer, ctx, id, roomId, wakeText ?? message, sender);
    if (!queued.accepted) {
      failed.push(id);
      reasons.push(id + (queued.reason === undefined ? '' : ' (' + queued.reason + ')'));
    }
  }
  if (failed.length > 0) {
    // The post itself is real and visible, so the partial outcome still carries the delivered-text
    // metadata: the run loop must never repeat this visible text in a final report, and the error
    // text names exactly which mention wakes were not queued.
    return {
      ok: false,
      result: errorResult(
        'Posted to room ' + roomId + ' but the mention wake was not queued for: ' + reasons.join(', '),
        { deliveredText: markdown, deliveredConversationId: roomId, roomDelivery: { roomId, targets: others, failed } },
      ),
    };
  }
  return { ok: true, value: { roomId, markdown, queued: others } };
}

async function queueRoomMention(
  enqueuer: Enqueuer,
  ctx: ToolContext,
  targetId: string,
  roomId: string,
  message: string,
  sender: Record<string, string | boolean>,
): Promise<{ accepted: boolean; reason?: string }> {
  const currentHop = ctx.wake.hop?.depth ?? 0;
  const wake: WakeEvent = {
    id: newId('wke'),
    ownerId: ctx.ownerId,
    agentId: targetId,
    sessionKey: targetId + ':' + roomId,
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
  try {
    wakeEventSchema.parse(wake);
  } catch {
    return { accepted: false, reason: 'invalid wake event' };
  }
  try {
    return await enqueuer.enqueue(wake, { awaitDecision: true });
  } catch (error) {
    return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// Whether a feed_post call earns a clickable chat card.
// A card appears only for a run the owner started from this chat: directly from
// their message, or asynchronously when a user-requested notify child completes
// and the woken parent publishes. Everything else stays feed-only.
// Authority is canonical persisted rows only. The verdict for an async card is a
// private spawn-time stamp on the child row (feedCardUserOrigin), written by the
// child_spawn tool only when the spawning run was itself directly card-eligible
// (a user message in this chat) or continued a verified stamped chain. A bare
// kind=chat parent never authorizes a card: busy.ts maps agent_message,
// request_resolved, hand_back and private_handoff to chat too. The untrusted
// wake payload supplies ids to look up, never the verdict: a claimed originRunId
// must agree with the stored parent link, and the stored notifyParent link must
// match this run's owner, agent and conversation.
import type { Store, ToolContext } from '../../contracts/index.js';
import { isRoutineWake } from '../../contracts/index.js';
import { isChildRun } from '../tasks/childDelivery.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

interface NotifyLink {
  ownerId: string;
  agentId: string;
  conversationId: string;
  chainId: string;
}

function readNotifyLink(child: unknown): NotifyLink | undefined {
  if (!isRecord(child)) return undefined;
  const raw: unknown = Reflect.get(child, 'notifyParent');
  if (!isRecord(raw)) return undefined;
  const ownerId = stringField(raw, 'ownerId');
  const agentId = stringField(raw, 'agentId');
  const conversationId = stringField(raw, 'conversationId');
  const chainId = stringField(raw, 'chainId');
  if (ownerId === undefined || agentId === undefined || conversationId === undefined || chainId === undefined) return undefined;
  return { ownerId, agentId, conversationId, chainId };
}

function payloadTaskId(wake: ToolContext['wake']): string | undefined {
  const taskId: unknown = wake.payload['taskId'];
  const taskKind: unknown = wake.payload['taskKind'];
  if (typeof taskId !== 'string' || taskId.length === 0 || taskKind !== 'child') return undefined;
  return taskId;
}

function sameChat(ctx: ToolContext, agentId: string, conversationId: string | undefined): boolean {
  return agentId === ctx.agentId && conversationId === ctx.conversationId;
}

async function isBoundTopLevelParent(store: Store, ctx: ToolContext, rootId: string): Promise<boolean> {
  const root = await store.get('runs', rootId);
  if (root === null || root.parentRunId !== undefined) return false;
  return sameChat(ctx, root.agentId, root.conversationId);
}

async function isUserOriginAsyncCompletion(store: Store, ctx: ToolContext): Promise<boolean> {
  if (ctx.wake.kind !== 'task_done') return false;
  if (ctx.wake.origin.type !== 'system' || ctx.wake.trusted !== false) return false;
  if (isRoutineWake(ctx.wake)) return false;
  const taskId = payloadTaskId(ctx.wake);
  if (taskId === undefined) return false;
  const child = await store.get('runs', taskId);
  if (child === null) return false;
  if (Reflect.get(child, 'feedCardUserOrigin') !== true) return false;
  const parentRunId = child.parentRunId;
  if (parentRunId === undefined || parentRunId.length === 0) return false;
  const link = readNotifyLink(child);
  if (link === undefined) return false;
  if (link.ownerId !== ctx.ownerId || link.agentId !== ctx.agentId || link.conversationId !== ctx.conversationId) return false;
  if (child.conversationId !== undefined && child.conversationId !== ctx.conversationId) return false;
  const claimedOrigin: unknown = ctx.wake.payload['originRunId'];
  if (typeof claimedOrigin === 'string' && claimedOrigin.length > 0 && claimedOrigin !== parentRunId) return false;
  const current = await store.get('runs', ctx.runId);
  if (isChildRun(current)) return false;
  if (await isBoundTopLevelParent(store, ctx, link.chainId)) return true;
  return isBoundTopLevelParent(store, ctx, parentRunId);
}

export async function shouldAddFeedCard(store: Store, ctx: ToolContext): Promise<boolean> {
  const current = await store.get('runs', ctx.runId);
  if (isChildRun(current)) return false;
  if (isRoutineWake(ctx.wake)) return false;
  if (ctx.wake.kind === 'user_message' && ctx.wake.origin.type === 'user') return true;
  return isUserOriginAsyncCompletion(store, ctx);
}

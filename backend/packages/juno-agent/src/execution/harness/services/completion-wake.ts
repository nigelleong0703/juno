import type { Context } from '@agent-desktop/durable';
import { rpc } from '@agent-desktop/durable';
import { sessionKey, type Store, type TaskDonePayload, type WakeEvent } from '../../../contracts/index.js';
import { isTerminal, type ChildRun } from '../../../modules/tasks/childRead.js';
import { sessionDef, type SessionDef } from './definitions.js';

/** Where a completion wake goes: the session that started the background work. */
export interface CompletionTarget {
  ownerId: string;
  agentId: string;
  conversationId: string;
  /** The originating hop chain, carried so background work stays inside the caps of the chain that started it. */
  hop?: { chainId: string; depth: number };
}

type CompletionKind = 'task_done' | 'hand_back' | 'timer';

/**
 * A completion wake: system-origin, never trusted (its text is a result, not an instruction), background
 * priority. The id is supplied by the caller and must be deterministic for the event it reports, so a
 * replayed or retried producer delivers it exactly once (Session.receive dedupes on the id).
 */
export function buildCompletionWake(
  target: CompletionTarget,
  kind: CompletionKind,
  id: string,
  payload: Record<string, unknown>,
  at: string,
): WakeEvent {
  return {
    id,
    ownerId: target.ownerId,
    agentId: target.agentId,
    sessionKey: sessionKey(target.agentId, target.conversationId),
    conversationId: target.conversationId,
    kind,
    origin: { type: 'system' },
    trusted: false,
    priority: 'background',
    payload,
    ...(target.hop === undefined ? {} : { hop: target.hop }),
    at,
    status: 'accepted',
  };
}

export function taskDoneWake(target: CompletionTarget, payload: TaskDonePayload, at: string): WakeEvent {
  return buildCompletionWake(target, 'task_done', `${payload.taskId}:done`, { ...payload, text: payload.summary }, at);
}

/**
 * H-98: a task_done from work a child run started goes to that child's own session while the child is still
 * running, as a child_task steer (the child_message path): the child reads it at its next steer point. A child
 * that has ended, or a main-run origin, keeps the main session, the only place left that can act. Checked at
 * delivery, so a delayed completion (a wait_for expiry) routes by the child's state when it lands. Null = keep.
 */
export async function childCompletionRoute(store: Store, event: WakeEvent): Promise<{ sessionKey: string; wake: WakeEvent } | null> {
  if (event.kind !== 'task_done') return null;
  const origin = event.payload['originRunId'];
  if (typeof origin !== 'string' || origin.length === 0) return null;
  const child: ChildRun | null = await store.get('runs', origin);
  if (child === null || child.parentRunId === undefined || child.childSessionKey === undefined || isTerminal(child.status)) return null;
  return {
    sessionKey: child.childSessionKey,
    wake: {
      ...event,
      agentId: child.agentId,
      conversationId: child.conversationId ?? event.conversationId,
      sessionKey: child.childSessionKey,
      kind: 'child_task',
      mode: 'steer',
      payload: { ...event.payload, childRunId: child.id, parentRunId: child.parentRunId },
    },
  };
}

/**
 * Deliver a completion wake from inside a Restate handler. The send is journaled by Restate, so a
 * replay never sends twice; `delayMs` schedules it (used by wake_at).
 */
export function sendCompletionWake(ctx: Pick<Context, 'objectSendClient'>, wake: WakeEvent, delayMs?: number): void {
  const client = ctx.objectSendClient<SessionDef>(sessionDef, wake.sessionKey);
  if (delayMs !== undefined && delayMs > 0) client.receive(wake, rpc.sendOpts({ delay: delayMs }));
  else client.receive(wake);
}

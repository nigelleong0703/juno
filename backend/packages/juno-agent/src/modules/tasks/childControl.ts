/**
 * child_cancel — a parent-only control over the tasks IT spawned.
 *
 * The cancellation is real: ctx.enqueuer.stopRun cancels the child's actual run, and the run's own
 * terminal state stays authoritative (never a fabricated status patch). It is idempotent and
 * replay-safe: a repeat on an already-ended child reports that state and dispatches nothing, and a
 * replayed dispatch re-sends the same idempotent cancel. A child that raced to completion (or
 * failed) between dispatch and the terminal re-read is reported with its OWN final status.
 */
import { z } from 'zod';
import type { Store, Tool, ToolContext, ToolResult } from '../../contracts/index.js';
import { docOwner } from '../../execution/execution-owner.js';
import { isTerminal, type ChildRun } from './childRead.js';
import { recordRunStop } from './stop-record.js';

export const childCancelSchema = z.object({ runId: z.string().min(1) });

const REFUSALS = {
  parent_missing: 'the parent run is not known in this scope',
  parent_context_mismatch: 'the calling run does not belong to the requesting owner, agent and conversation',
  not_own_child: 'child %RUN% is not a child of this run',
  stop_failed: 'the stop request for child %RUN% failed; retry the same child_cancel',
} as const;

export type ChildCancelRefusal = keyof typeof REFUSALS;

/** status is always the run row's own status; the state only says what this call actually did. */
export type ChildCancelOutcome =
  | { ok: true; runId: string; state: 'awaiting_stop' | 'already_terminal' | 'terminal'; status: ChildRun['status'] }
  | { ok: false; reason: ChildCancelRefusal; runId?: string };

export function childCancelRefusalText(reason: ChildCancelRefusal, runId: string): string {
  return REFUSALS[reason].replace('%RUN%', runId);
}

/** The parent-facing tool: names exactly one own child and reports the truthful cancellation state. */
export function createChildCancelTool(): Tool {
  return {
    name: 'child_cancel',
    description: '',
    parameters: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false },
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = childCancelSchema.parse(args);
      const outcome = await cancelChildRun(ctx.store, (runId) => ctx.enqueuer.stopRun(runId), {
        ownerId: ctx.ownerId,
        agentId: ctx.agentId,
        parentRunId: ctx.runId,
        childRunId: parsed.runId,
        conversationId: ctx.conversationId,
      });
      if (!outcome.ok) {
        return {
          content: [{ type: 'text', text: childCancelRefusalText(outcome.reason, parsed.runId) }],
          isError: true,
          details: { child: true, refused: outcome.reason },
        };
      }
      const awaiting = outcome.state === 'awaiting_stop';
      const text = awaiting
        ? 'Cancellation requested for child ' + outcome.runId + '; its own terminal state will show the stop. Read child_results later.'
        : outcome.state === 'already_terminal'
          ? 'Child ' + outcome.runId + ' already ended (status ' + outcome.status + '); nothing to stop.'
          : 'Child ' + outcome.runId + ' is now ' + outcome.status + '.';
      return {
        content: [{ type: 'text', text }],
        details: { child: true, cancelled: outcome.runId, awaitingStop: awaiting, alreadyTerminal: outcome.state === 'already_terminal', status: outcome.status },
      };
    },
  };
}

/** Who may act on a child: the named run must be a child of the calling run, in its conversation and owner scope. */
export interface ChildAccess {
  ownerId: string;
  agentId: string;
  parentRunId: string;
  childRunId: string;
  conversationId: string;
}

/** The child row when the calling run owns it (shared by child_cancel and child_message), else the refusal. */
export async function authorizeOwnChild(store: Store, input: ChildAccess): Promise<{ ok: true; child: ChildRun } | { ok: false; reason: ChildCancelRefusal }> {
  const { childRunId } = input;
  if (childRunId === input.parentRunId) return { ok: false, reason: 'not_own_child' };
  const child: ChildRun | null = await store.get('runs', childRunId);
  if (child === null || child.parentRunId === undefined) return { ok: false, reason: 'not_own_child' };
  if (child.conversationId !== input.conversationId) return { ok: false, reason: 'not_own_child' };
  const childOwner = docOwner(child);
  if (childOwner !== undefined && childOwner !== input.ownerId) return { ok: false, reason: 'not_own_child' };
  const parent: ChildRun | null = await store.get('runs', input.parentRunId);
  if (parent === null) return { ok: false, reason: 'parent_missing' };
  // The parent's agent proves the caller's scope even when owner metadata is absent; a present
  // owner stamp must match too. The enqueuer's current ctx already enforces the real scope.
  if (parent.agentId !== input.agentId) return { ok: false, reason: 'parent_context_mismatch' };
  if (parent.conversationId !== input.conversationId) return { ok: false, reason: 'parent_context_mismatch' };
  const parentOwner = docOwner(parent);
  if (parentOwner !== undefined && parentOwner !== input.ownerId) return { ok: false, reason: 'parent_context_mismatch' };
  if (child.parentRunId !== input.parentRunId && !(await isEarlierSpawner(store, child.parentRunId, parent, input))) {
    return { ok: false, reason: 'not_own_child' };
  }
  return { ok: true, child };
}

/**
 * A background child reports to its spawning run, which may have ended: the task_done it sends wakes the
 * agent into a NEW run. That later run may control the child its earlier run of the same agent, in the same
 * conversation and owner, spawned — and no other child. A child run never takes this path: its siblings were
 * spawned by the same earlier run, so only a root (non-child) run may.
 */
async function isEarlierSpawner(store: Store, spawnerRunId: string | undefined, caller: ChildRun, input: ChildAccess): Promise<boolean> {
  if (spawnerRunId === undefined || caller.parentRunId !== undefined) return false;
  const spawner: ChildRun | null = await store.get('runs', spawnerRunId);
  if (spawner === null || spawner.agentId !== input.agentId || spawner.conversationId !== input.conversationId) return false;
  const spawnerOwner = docOwner(spawner);
  if (spawnerOwner !== undefined && spawnerOwner !== input.ownerId) return false;
  return Date.parse(spawner.startedAt) <= Date.parse(caller.startedAt);
}

export async function cancelChildRun(
  store: Store,
  stop: (runId: string) => Promise<void>,
  input: ChildAccess,
): Promise<ChildCancelOutcome> {
  const { childRunId } = input;
  const access = await authorizeOwnChild(store, input);
  if (!access.ok) return { ok: false, reason: access.reason, runId: childRunId };
  const child = access.child;
  // Terminal is terminal: the run already ended, so report that and dispatch nothing.
  if (isTerminal(child.status)) return { ok: true, runId: childRunId, state: 'already_terminal', status: child.status };
  // Only the agent's own tools cancel a child through here: the task list shows it as stopped by the agent, not by the owner.
  await recordRunStop(store, childRunId, 'agent');
  try {
    await stop(childRunId);
  } catch {
    return { ok: false, reason: 'stop_failed', runId: childRunId };
  }
  const after: ChildRun | null = await store.get('runs', childRunId);
  // Cancellation is asynchronous: until the run itself rewrites its terminal state the truthful
  // report is 'awaiting_stop' — never a fabricated status.
  if (after !== null && after.status !== child.status && isTerminal(after.status)) return { ok: true, runId: childRunId, state: 'terminal', status: after.status };
  return { ok: true, runId: childRunId, state: 'awaiting_stop', status: child.status };
}

/**
 * A parent-only control over the subagents IT started (stopped through task_stop, messaged through subagent_message).
 *
 * The cancellation is real: ctx.enqueuer.stopRun cancels the child's actual run, and the run's own
 * terminal state stays authoritative (never a fabricated status patch). It is idempotent and
 * replay-safe: a repeat on an already-ended child reports that state and dispatches nothing, and a
 * replayed dispatch re-sends the same idempotent cancel. A child that raced to completion (or
 * failed) between dispatch and the terminal re-read is reported with its OWN final status.
 */
import type { Store } from '../../contracts/index.js';
import { docOwner } from '../../execution/execution-owner.js';
import { isTerminal, type SubagentRun } from './subagentRead.js';
import { recordRunStop } from './stop-record.js';

const REFUSALS = {
  parent_missing: 'the parent run is not known in this scope',
  parent_context_mismatch: 'the calling run does not belong to the requesting owner, agent and conversation',
  not_own_child: 'subagent %RUN% is not a subagent of this run',
  stop_failed: 'the stop request for subagent %RUN% failed; retry the same task_stop',
} as const;

export type SubagentCancelRefusal = keyof typeof REFUSALS;

/** status is always the run row's own status; the state only says what this call actually did. */
export type SubagentCancelOutcome =
  | { ok: true; runId: string; state: 'awaiting_stop' | 'already_terminal' | 'terminal'; status: SubagentRun['status'] }
  | { ok: false; reason: SubagentCancelRefusal; runId?: string };

export function subagentCancelRefusalText(reason: SubagentCancelRefusal, runId: string): string {
  return REFUSALS[reason].replace('%RUN%', runId);
}

/** Who may act on a child: the named run must be a child of the calling run, in its conversation and owner scope. */
export interface SubagentAccess {
  ownerId: string;
  agentId: string;
  parentRunId: string;
  subagentRunId: string;
  conversationId: string;
}

/** The child row when the calling run owns it (shared by task_stop and subagent_message), else the refusal. */
export async function authorizeOwnSubagent(store: Store, input: SubagentAccess): Promise<{ ok: true; child: SubagentRun } | { ok: false; reason: SubagentCancelRefusal }> {
  const { subagentRunId } = input;
  if (subagentRunId === input.parentRunId) return { ok: false, reason: 'not_own_child' };
  const child: SubagentRun | null = await store.get('runs', subagentRunId);
  if (child === null || child.parentRunId === undefined) return { ok: false, reason: 'not_own_child' };
  if (child.conversationId !== input.conversationId) return { ok: false, reason: 'not_own_child' };
  const subagentOwner = docOwner(child);
  if (subagentOwner !== undefined && subagentOwner !== input.ownerId) return { ok: false, reason: 'not_own_child' };
  const parent: SubagentRun | null = await store.get('runs', input.parentRunId);
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
async function isEarlierSpawner(store: Store, spawnerRunId: string | undefined, caller: SubagentRun, input: SubagentAccess): Promise<boolean> {
  if (spawnerRunId === undefined || caller.parentRunId !== undefined) return false;
  const spawner: SubagentRun | null = await store.get('runs', spawnerRunId);
  if (spawner === null || spawner.agentId !== input.agentId || spawner.conversationId !== input.conversationId) return false;
  const spawnerOwner = docOwner(spawner);
  if (spawnerOwner !== undefined && spawnerOwner !== input.ownerId) return false;
  return Date.parse(spawner.startedAt) <= Date.parse(caller.startedAt);
}

export async function cancelSubagentRun(
  store: Store,
  stop: (runId: string) => Promise<void>,
  input: SubagentAccess,
): Promise<SubagentCancelOutcome> {
  const { subagentRunId } = input;
  const access = await authorizeOwnSubagent(store, input);
  if (!access.ok) return { ok: false, reason: access.reason, runId: subagentRunId };
  const child = access.child;
  // Terminal is terminal: the run already ended, so report that and dispatch nothing.
  if (isTerminal(child.status)) return { ok: true, runId: subagentRunId, state: 'already_terminal', status: child.status };
  // Only the agent's own tools cancel a child through here: the task list shows it as stopped by the agent, not by the owner.
  await recordRunStop(store, subagentRunId, 'agent');
  try {
    await stop(subagentRunId);
  } catch {
    return { ok: false, reason: 'stop_failed', runId: subagentRunId };
  }
  const after: SubagentRun | null = await store.get('runs', subagentRunId);
  // Cancellation is asynchronous: until the run itself rewrites its terminal state the truthful
  // report is 'awaiting_stop' — never a fabricated status.
  if (after !== null && after.status !== child.status && isTerminal(after.status)) return { ok: true, runId: subagentRunId, state: 'terminal', status: after.status };
  return { ok: true, runId: subagentRunId, state: 'awaiting_stop', status: child.status };
}

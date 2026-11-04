/**
 * CT-boundary: parent completion while child tasks run.
 *
 * A parent may not finish while a child it spawned is still live, even when its own plan is done
 * or absent. Each held final appends one trusted internal hint pointing at the child tools, and
 * the same live child set across consecutive finals without a tool turn is a no-progress stall
 * that blocks truthfully instead of looping forever; the step limit reports live children too.
 * Nothing here cancels a child: the model or the user decides through task_stop / stop.
 */
import type { Store } from '../../../contracts/index.js';
import { isTerminal, listSubagentTasks, type SubagentStatus } from '../../../modules/tasks/subagent.js';

/** Live children of one parent: terminal children (completed/failed/stopped/blocked) are settled. */
export async function activeSubagents(store: Store, parentRunId: string): Promise<SubagentStatus[]> {
  // H-70: a background child reports back by itself, so it never holds the parent's final reply.
  return (await listSubagentTasks(store, parentRunId)).filter((child) => !isTerminal(child.status) && !child.background);
}

/** Stable signature of the live child set; a change means the gate observed progress. */
export function subagentSignature(active: readonly SubagentStatus[]): string {
  return active.map((child) => child.runId + ':' + child.status).sort().join('|');
}

/** The trusted internal hint a held final leaves for the model. */
export function subagentContinueHint(active: readonly SubagentStatus[]): string {
  const named = active.map((child) => child.runId + ' (' + child.title + ', ' + child.status + ')').join(', ');
  return '[internal child check] ' + String(active.length) + ' subagent(s) are still active: ' + named +
    '. This run cannot finish while its children run: read their status and results with tasks_list (output_read for a long result), ' +
    'or stop one you no longer need with task_stop.';
}

/** The truthful block reason when children stay live: stalled finals or the step limit. It reaches the task line, so it names no run ids (the subagents are tasks of their own). */
export function subagentBlockedReason(active: readonly SubagentStatus[], limitReached: boolean): string {
  const lead = limitReached ? 'the step limit was reached with ' : 'no progress while ';
  return 'run blocked: ' + lead + String(active.length) + ' subagent(s) still active';
}

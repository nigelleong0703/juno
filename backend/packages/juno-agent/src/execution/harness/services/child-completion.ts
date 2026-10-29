/**
 * CT-boundary: parent completion while child tasks run.
 *
 * A parent may not finish while a child it spawned is still live, even when its own plan is done
 * or absent. Each held final appends one trusted internal hint pointing at the child tools, and
 * the same live child set across consecutive finals without a tool turn is a no-progress stall
 * that blocks truthfully instead of looping forever; the step limit reports live children too.
 * Nothing here cancels a child: the model or the user decides through child_cancel / stop.
 */
import type { Store } from '../../../contracts/index.js';
import { isTerminal, listChildTasks, type ChildStatus } from '../../../modules/tasks/child.js';

/** Live children of one parent: terminal children (completed/failed/stopped/blocked) are settled. */
export async function activeChildren(store: Store, parentRunId: string): Promise<ChildStatus[]> {
  // H-70: a background child reports back by itself, so it never holds the parent's final reply.
  return (await listChildTasks(store, parentRunId)).filter((child) => !isTerminal(child.status) && !child.background);
}

/** Stable signature of the live child set; a change means the gate observed progress. */
export function childSignature(active: readonly ChildStatus[]): string {
  return active.map((child) => child.runId + ':' + child.status).sort().join('|');
}

/** The trusted internal hint a held final leaves for the model. */
export function childContinueHint(active: readonly ChildStatus[]): string {
  const named = active.map((child) => child.runId + ' (' + child.title + ', ' + child.status + ')').join(', ');
  return '[internal child check] ' + String(active.length) + ' child task(s) are still active: ' + named +
    '. This run cannot finish while its children run: collect their output with child_results, ' +
    'block on them with child_wait, or stop a child you no longer need with child_cancel.';
}

/** The truthful block reason when children stay live: stalled finals or the step limit. */
export function childBlockedReason(active: readonly ChildStatus[], limitReached: boolean): string {
  const lead = limitReached ? 'the step limit was reached with ' : 'no progress while ';
  return 'run blocked: ' + lead + String(active.length) + ' child task(s) still active: ' +
    active.map((child) => child.runId).join(', ');
}

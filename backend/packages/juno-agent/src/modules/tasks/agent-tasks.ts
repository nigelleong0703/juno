/**
 * Announcing the task tree (BACKEND 6.5). What the clients see is the projection in `work-view.ts`; this file is the
 * write side's way of saying "this source row changed": every change is one `task.updated` (an upsert by id), emitted
 * through the same store write (inside its transaction when there is one). The agent's declared tasks (`agentTasks`
 * rows, written by `task_update`) are closed here when the run doing them ends.
 */
import type { Run } from '@agent-desktop/public-contracts';
import type { BackgroundTask, DeclaredTask, Store } from '../../contracts/index.js';
import { isTerminal } from './childRead.js';
import { subagentStartedEvent, subagentTerminalEvent } from '../../execution/harness/services/agui-events.js';
import { isSubagentRun, isWorkRun, projectBackground, projectDeclared, projectRun, type WorkRun } from './work-view.js';

export { oneLine } from './work-view.js';

/** Declared tasks one run can leave open: the bound of the close-out read. */
export const AGENT_TASKS_MAX = 50;

/** Announce a declared task's state. */
export async function emitDeclaredTask(store: Store, task: DeclaredTask): Promise<void> {
  const projected = await projectDeclared(store, task);
  if (projected !== null) await store.emit({ type: 'task.updated', task: projected });
}

export async function emitBackgroundTask(store: Store, task: BackgroundTask): Promise<void> {
  const projected = await projectBackground(store, task);
  if (projected !== null) await store.emit({ type: 'task.updated', task: projected });
}

/**
 * Announce a task that is a run: a child run (subagent) or a routine run. A plain run is not a task and emits nothing.
 * With `lifecycle` a subagent also opens or closes its standard AG-UI segment.
 */
export async function emitRunTask(store: Store, run: Run, lifecycle = false): Promise<void> {
  const work: WorkRun = run;
  if (!isWorkRun(work)) return;
  const projected = await projectRun(store, work);
  if (projected !== null) await store.emit({ type: 'task.updated', task: projected });
  if (!lifecycle || !isSubagentRun(work)) return;
  // The same durable child run also opens/closes the standard AG-UI subagent segment. A nested
  // child names its parent subagent invocation; a top-level parent is plain attribution in metadata.
  if (!isTerminal(work.status)) {
    const parent = work.parentRunId === undefined ? null : await store.get('runs', work.parentRunId);
    await store.emit(subagentStartedEvent(work, parent !== null && isSubagentRun(parent)));
    return;
  }
  await store.emit(subagentTerminalEvent(work));
}

/** The status a declared task still `running` gets when its run ends: no task is left dangling. */
function closingStatus(runStatus: Run['status']): DeclaredTask['status'] {
  if (runStatus === 'completed') return 'completed';
  return runStatus === 'stopped' ? 'stopped' : 'failed';
}

/**
 * A run reached a terminal state: close the declared tasks it left running, and announce the run's own task when it is
 * a child or routine run. A `waiting` task stays open: the agent asked the user and resumes it.
 */
export async function closeRunTasks(store: Store, run: Run): Promise<void> {
  const open = await store.list('agentTasks', { where: { runId: run.id, status: 'running' }, limit: AGENT_TASKS_MAX });
  const at = run.finishedAt ?? new Date().toISOString();
  // The run's stop was asked for by somebody (recorded where it was requested); its tasks were stopped by the same one.
  const stoppedBy = run.status === 'stopped' ? ((await store.get('runs', run.id))?.stoppedBy) : undefined;
  for (const task of open.items) {
    const closed = await store.patch('agentTasks', task.id, { status: closingStatus(run.status), updatedAt: at, finishedAt: at, ...(stoppedBy === undefined ? {} : { stoppedBy }) });
    await emitDeclaredTask(store, closed);
  }
  await emitRunTask(store, run, true);
}

/** The newest running declared task's progress (else its title): the agent's "doing" line. */
export async function runningTaskLine(store: Store, agentId: string): Promise<string | undefined> {
  const running = await store.list('agentTasks', { where: { agentId, status: 'running' }, orderBy: 'at', order: 'desc', limit: 10 });
  const newest = [...running.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return newest === undefined ? undefined : (newest.progress ?? newest.title);
}

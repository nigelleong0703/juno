/**
 * The background-job registry (H-72/H-73, task list): one small `backgroundTasks` row per shell process,
 * MCP background call or wait_for notify, so the model can list and stop its background work after
 * compaction. Child runs are not copied here; their run rows are read by tasks_list.
 */
import { patchWhen, type BackgroundTask, type StopActor, type Store } from '../../contracts/index.js';
import { emitBackgroundTask } from './agent-tasks.js';

/**
 * H-97: the background MCP calls running in this process, by task id. task_stop aborts one here, which makes
 * the MCP client send notifications/cancelled. This map is only the fast path: a stop made by another process
 * (the coordinator's HTTP route) marks the task row, and the process running the call sees that through
 * `backgroundCancellation`'s database poll and aborts it the same way.
 */
const inFlightCalls = new Map<string, AbortController>();

/** Register a call as in flight; its signal ends the call when the task is stopped. */
export function trackBackgroundCall(taskId: string): AbortSignal {
  const controller = new AbortController();
  inFlightCalls.set(taskId, controller);
  return controller.signal;
}

export function untrackBackgroundCall(taskId: string): void {
  inFlightCalls.delete(taskId);
}

/** Abort a tracked call; false when this process holds none for the task (already finished, or another process). */
export function abortBackgroundCall(taskId: string): boolean {
  const controller = inFlightCalls.get(taskId);
  if (controller === undefined) return false;
  inFlightCalls.delete(taskId);
  controller.abort(new Error('stopped by the agent'));
  return true;
}

/**
 * Harness options every MCP tool accepts (H-73), stripped before the server sees the call: `background`,
 * and `taskTitle`, the agent's title for its task list (not `title`, which real tools take as an argument).
 */
export const BACKGROUND_OPTIONS: readonly string[] = ['background', 'taskTitle'];

/** A one-line, bounded description: the command, tool name or filter. */
export function taskLabel(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Record a started job. A replay rewrites the same row, so the registry never holds two entries for one job. */
export async function recordBackgroundTask(store: Store, task: BackgroundTask): Promise<void> {
  // The job hangs under the run that started it, in that run's tree: copy the root once, here (BACKEND 6.5).
  const run = task.rootRunId === undefined ? await store.get('runs', task.runId) : null;
  const rootRunId = task.rootRunId ?? run?.rootRunId ?? task.runId;
  await emitBackgroundTask(store, await store.put('backgroundTasks', { ...task, rootRunId }));
}

/**
 * Write a job's end. Only a still-running row changes, so a stop that landed first is never overwritten by
 * a later completion report (and the reverse). Returns the row as it now stands, or null when there is none.
 */
export async function endBackgroundTask(store: Store, id: string, status: BackgroundTask['status'], at: string, outcome?: string, stopDelivery?: BackgroundTask['stopDelivery'], stoppedBy?: StopActor): Promise<BackgroundTask | null> {
  // The stop comes from the coordinator and the completion from a worker: the row lock decides which one lands first.
  const ended = await patchWhen(store, 'backgroundTasks', id, (current) => current.status === 'running', {
    status,
    endedAt: at,
    ...(outcome === undefined ? {} : { outcome }),
    ...(stopDelivery === undefined ? {} : { stopDelivery }),
    ...(stoppedBy === undefined ? {} : { stoppedBy }),
  });
  if (ended === undefined) return store.get('backgroundTasks', id);
  await emitBackgroundTask(store, ended);
  return ended;
}

/** The task-list outcome of an ended process. */
export function exitOutcome(exitCode: number | null | undefined): string | undefined {
  return typeof exitCode === 'number' ? 'Exited with code ' + String(exitCode) : undefined;
}

/**
 * The sandbox's answer for a handle its computer does not hold (it expired, or the computer was replaced): the text of
 * `unknownMessage` in sandbox-adapters/processes.ts, which reaches us inside a ComputerError / ComputerdClientError.
 */
const UNKNOWN_PROCESS_TEXT = 'is not known on this computer';

export function isUnknownProcess(error: unknown): boolean {
  return error instanceof Error && error.message.includes(UNKNOWN_PROCESS_TEXT);
}

export const ORPHAN_OUTCOME = 'The process no longer exists (its computer was replaced, or it expired)';

/** How a process that is no longer running ends its task row. */
export function processEnd(state: string, exitCode: number | null | undefined): { status: Exclude<BackgroundTask['status'], 'running'>; outcome?: string } {
  if (state === 'exited') {
    const outcome = exitOutcome(exitCode);
    return { status: exitCode === 0 ? 'completed' : 'failed', ...(outcome === undefined ? {} : { outcome }) };
  }
  if (state === 'stopped') return { status: 'stopped' };
  return { status: 'failed', outcome: ORPHAN_OUTCOME };
}

/** Settle a shell task from what its process was seen doing (a poll, the boot sweep). A process still running changes nothing. */
export async function settleShellTask(store: Store, id: string, seen: { state: string; exitCode?: number | null }, at: string = new Date().toISOString()): Promise<void> {
  if (seen.state === 'running') return;
  const end = processEnd(seen.state, seen.exitCode);
  await endBackgroundTask(store, id, end.status, at, end.outcome);
}

/** Stops a shell process by handle (the sandbox's process stop), when this host can. */
export type StopProcess = (handle: string) => Promise<{ state: string; exitCode: number | null }>;

/**
 * Stop one registry job (task_stop and the user's `POST /v1/tasks/:id/stop`): a shell process is stopped,
 * a wait is dropped, a background MCP call is aborted in this process or else marked stopped so its
 * result is dropped. Returns the sentence the caller reports; `ok: false` when nothing could be done.
 */
export async function stopBackgroundTask(store: Store, task: BackgroundTask, stopProcess: StopProcess | undefined, by: StopActor): Promise<{ ok: boolean; text: string }> {
  if (task.status !== 'running') return { ok: true, text: 'Task ' + task.id + ' already ended (status ' + task.status + '); nothing to stop.' };
  const at = new Date().toISOString();
  if (task.kind === 'shell') {
    if (stopProcess === undefined || task.handle === undefined) return { ok: false, text: 'Process control is not available here; the process cannot be stopped.' };
    let stopped;
    try {
      stopped = await stopProcess(task.handle);
    } catch (error) {
      if (!isUnknownProcess(error)) throw error;
      // An orphan (its computer was replaced): nothing to stop, so the row is closed instead of staying running forever.
      await endBackgroundTask(store, task.id, 'failed', at, ORPHAN_OUTCOME);
      return { ok: true, text: 'Process ' + task.handle + ' no longer exists on this computer; the task is closed.' };
    }
    const exited = stopped.state === 'exited';
    await endBackgroundTask(store, task.id, exited ? 'completed' : 'stopped', at, exitOutcome(stopped.exitCode), undefined, exited ? undefined : by);
    return { ok: true, text: 'Process ' + task.handle + ' is ' + stopped.state + (stopped.exitCode === null ? '' : ' (exit ' + String(stopped.exitCode) + ')') + '.' };
  }
  if (task.kind === 'wait') {
    await endBackgroundTask(store, task.id, 'stopped', at, undefined, undefined, by);
    if ((await store.get('subscriptions', task.id)) !== null) await store.delete('subscriptions', task.id);
    return { ok: true, text: 'Stopped waiting for ' + task.id + '; a matching event will no longer wake you.' };
  }
  // Mark first: a completion that lands now finds the stop and stays silent. The mark says whether this process holds the
  // call to cancel (H-97) or the row is all that changes, so the task list can show a stop nobody confirmed (BACKEND 6.5).
  const aborting = inFlightCalls.has(task.id);
  await endBackgroundTask(store, task.id, 'stopped', at, undefined, aborting ? 'aborted' : 'marked', by);
  // H-97: an in-flight call in this process is aborted (notifications/cancelled); elsewhere it is only marked.
  if (abortBackgroundCall(task.id)) return { ok: true, text: 'Background call ' + task.id + ' is stopped: its in-flight call was cancelled, but the server may still finish it; its result is dropped.' };
  return { ok: true, text: 'Background call ' + task.id + ' is marked stopped: its result will be dropped, but the in-flight call may still complete on the server.' };
}

/**
 * TaskWatcher Virtual Object (H-72): watches one background process (shell.start with notifyOnExit)
 * until it ends, then sends its session exactly one task_done. Each tick reads the process state once
 * (journaled), then re-arms itself with a delayed self-send whose interval doubles up to a cap, so a
 * long build is polled rarely. A lifetime cap ends the watch as a timeout; repeated read failures end
 * it as failed. A process the agent stopped itself reports nothing (it already knows). The end report
 * carries the output head and tail, redacted, with the full text kept as an artifact (output_read).
 */
import { object, rpc, type ObjectContext } from '@agent-desktop/durable';
import type { BackgroundTask, Store, TaskWatchStart, WakeEvent } from '../../../contracts/index.js';
import type { ComputerClient } from '../../../ports/computer/index.js';
import { inOwnerScope } from '../../execution-owner.js';
import { sendCompletionWake, taskDoneWake } from './completion-wake.js';
import { reportSummary } from './output-capture.js';
import { endBackgroundTask, exitOutcome } from '../../../modules/tasks/background-registry.js';
import { taskWatcherDef } from './definitions.js';

type TaskWatcherDef = typeof taskWatcherDef;

export const WATCH_MIN_INTERVAL_MS = 5_000;
export const WATCH_MAX_INTERVAL_MS = 5 * 60_000;
export const WATCH_LIFETIME_MS = 24 * 60 * 60_000;
export const WATCH_MAX_READ_ERRORS = 5;
/** Output window read at the end: the sandbox clamps a read to its own maximum (32 KiB per stream). */
const WATCH_READ_BYTES = 32 * 1024;
/** The task_done summary's bound; a longer one is kept whole as an artifact (reportSummary). */
const SUMMARY_MAX = 2_000;

export interface WatchState {
  attempt: number;
  errors: number;
  done: boolean;
}

/** The context surface a tick needs; Restate adapts to it, tests fake it. */
export interface WatcherContext {
  key: string;
  store: Store;
  dateNow(): Promise<number>;
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
  getState(): Promise<WatchState | null>;
  setState(state: WatchState): void;
  rearm(input: TaskWatchStart, delayMs: number): void;
  sendWake(wake: WakeEvent): void;
}

/** How a watched process can end, as the registry records it (a stop is written by the agent, not reported). */
type EndStatus = Exclude<BackgroundTask['status'], 'running' | 'stopped'>;

/** A read the journal may hold from before the stderr/cursor fields existed, so those are optional here. */
type ReadOk = { state: string; exitCode: number | null; output: string; stderr?: string; cursor?: number; truncated?: boolean };
type Read = ReadOk | { error: string };

export function watchInterval(attempt: number): number {
  return Math.min(WATCH_MAX_INTERVAL_MS, WATCH_MIN_INTERVAL_MS * 2 ** Math.max(0, attempt));
}

/** The end report's text: the state, exit code, then the output and stderr windows, with where to read on. */
function endText(input: TaskWatchStart, read: ReadOk): string {
  const code = read.exitCode;
  const out = read.output.trim();
  const err = (read.stderr ?? '').trim();
  const more = read.truncated === true ? ' More output remains: shell.poll handle=' + input.handle + ' cursor=' + String(read.cursor ?? 0) + '.' : '';
  return 'Process ' + input.handle + ' ' + read.state + (code === null ? '' : ' with exit code ' + String(code)) + '.' +
    (out ? ' Output: ' + out : '') + (err ? ' Stderr: ' + err : '') + more;
}

/** One watch tick: read, then either re-arm or report the end exactly once. */
export async function watchTick(ctx: WatcherContext, computer: ComputerClient | undefined, input: TaskWatchStart): Promise<void> {
  if (ctx.key !== input.taskId) return;
  const state = (await ctx.getState()) ?? { attempt: 0, errors: 0, done: false };
  if (state.done) return;
  const now = await ctx.dateNow();
  const read = await ctx.run('read:' + String(state.attempt), async (): Promise<Read> => {
    const readProcess = computer?.readProcess?.bind(computer);
    if (readProcess === undefined) return { error: 'this deployment cannot read background processes' };
    try {
      const out = await inOwnerScope(input.ownerId, () => readProcess(input.agentId, { handle: input.handle, maxBytes: WATCH_READ_BYTES }, AbortSignal.timeout(15_000), input.computer));
      return { state: out.state, exitCode: out.exitCode, output: out.output, stderr: out.stderr, cursor: out.cursor, truncated: out.truncated };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  const finish = async (status: EndStatus, text: string, outcome?: string): Promise<void> => {
    ctx.setState({ ...state, done: true });
    const at = new Date(now).toISOString();
    const summary = await ctx.run('summary:' + String(state.attempt), () => inOwnerScope(input.ownerId, () => reportSummary(ctx.store, {
      ownerId: input.ownerId, agentId: input.agentId, runId: input.originRunId ?? input.taskId, stepId: 'task-' + input.taskId, tool: 'shell.start',
    }, text, SUMMARY_MAX)));
    const task = await ctx.run('end:' + String(state.attempt), () => inOwnerScope(input.ownerId, () => endBackgroundTask(ctx.store, input.taskId, status, at, outcome)));
    // The agent stopped this process itself between the read and the end: it already knows, so no wake.
    if (task?.status === 'stopped') return;
    ctx.sendWake(taskDoneWake(
      { ownerId: input.ownerId, agentId: input.agentId, conversationId: input.conversationId, ...(input.hop === undefined ? {} : { hop: input.hop }) },
      { taskId: input.taskId, taskKind: 'shell', status, summary, ...(input.generation === undefined ? {} : { generation: input.generation }), ...(input.originRunId === undefined ? {} : { originRunId: input.originRunId }) },
      at,
    ));
  };
  if ('error' in read) {
    const errors = state.errors + 1;
    if (errors >= WATCH_MAX_READ_ERRORS) return finish('failed', 'Could not read process ' + input.handle + ': ' + read.error);
    ctx.setState({ ...state, attempt: state.attempt + 1, errors });
    return ctx.rearm(input, watchInterval(state.attempt));
  }
  if (read.state === 'running') {
    if (now - input.startedAt > WATCH_LIFETIME_MS) return finish('timeout', 'Process ' + input.handle + ' still running after 24h; stopped watching. Use shell.poll to check it.');
    ctx.setState({ attempt: state.attempt + 1, errors: 0, done: false });
    return ctx.rearm(input, watchInterval(state.attempt));
  }
  if (read.state === 'stopped') {
    ctx.setState({ ...state, done: true });
    return;
  }
  const status: EndStatus = read.state === 'exited' ? (read.exitCode === 0 ? 'completed' : 'failed') : 'timeout';
  return finish(status, endText(input, read), read.state === 'exited' ? exitOutcome(read.exitCode) : undefined);
}

export const createTaskWatcherService = (deps: { computer?: ComputerClient; store: Store }) =>
  object({
    name: 'TaskWatcher',
    handlers: {
      async watch(ctx: ObjectContext, input: TaskWatchStart): Promise<void> {
        await watchTick({
          key: ctx.key,
          store: deps.store,
          dateNow: () => ctx.date.now(),
          run: (name, fn) => ctx.run(name, fn),
          getState: () => ctx.get<WatchState>('state'),
          setState: (state) => ctx.set('state', state),
          rearm: (next, delayMs) => {
            ctx.objectSendClient<TaskWatcherDef>(taskWatcherDef, next.taskId).watch(next, rpc.sendOpts({ delay: delayMs }));
          },
          sendWake: (wake) => sendCompletionWake(ctx, wake),
        }, deps.computer, input);
      },
    },
  });

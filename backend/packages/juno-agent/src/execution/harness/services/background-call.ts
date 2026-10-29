/**
 * H-73: background MCP tool calls. A call made with `background: true` is authorized by the run
 * exactly like a foreground call (policy and approval on the real tool name); then, instead of
 * running inline, it is handed to the BackgroundCall Virtual Object and the model gets a task id at
 * once. The object runs the call once and sends the session one task_done with the result.
 * Fence: runFencedTool on the issuing step row, so a crash mid-call is reported as interrupted
 * instead of repeating an external side effect.
 */
import { object, type ObjectContext } from '@agent-desktop/durable';
import type { BackgroundCallStart, BlobStore, Doc, Store, Tool, ToolRegistry, ToolResult, WakeEvent, Enqueuer } from '../../../contracts/index.js';
import { inOwnerScope } from '../../execution-owner.js';
import { sendCompletionWake, taskDoneWake } from './completion-wake.js';
import type { ToolOutcome } from './tool-projection.js';
import { refusal } from './tool-projection.js';
import { freshRefusal } from './tool-policy.js';
import { backgroundResultText, reportSummary } from './output-capture.js';
import type { ToolRunContext } from './replay.js';
import { executeBackgroundAction } from './background-recovery.js';
import { backgroundCancellation } from './background-cancel.js';
import { recoveryArguments } from './recovery-ledger.js';
import { backgroundCapRefusal, backgroundSpawnOf, BACKGROUND_LIMIT_TEXT } from '../../../modules/tasks/child-background.js';
import { endBackgroundTask, recordBackgroundTask, taskLabel } from '../../../modules/tasks/background-registry.js';
import { oneLine } from '../../../modules/tasks/agent-tasks.js';
import type { RunInput, RunServices } from './run-types.js';

/** The task_done summary's bound; a longer result is kept whole as an artifact (reportSummary). */
const SUMMARY_MAX = 2_000;

/** True for a call the model asked to run in the background (MCP tools only). */
export function isBackgroundCall(call: { arguments: Record<string, unknown> }, tool: Pick<Tool, 'mcp'> | undefined): boolean {
  return tool?.mcp === true && call.arguments['background'] === true;
}

/** The agent's title for its task list, when it gave one. */
function titleArg(args: Record<string, unknown>): { title?: string } {
  const title = args['taskTitle'];
  return typeof title === 'string' && title.trim() !== '' ? { title: taskLabel(title) } : {};
}

/**
 * Hand an authorized background call to the BackgroundCall object. The policy re-check, the chain cap,
 * the start and the registry row run in ONE journaled step, so a replay returns the same decision and
 * starts the call once. A stop-free refusal comes back as an error result; null means it started.
 */
export async function startBackgroundCall(
  ctx: { run<T>(name: string, action: () => Promise<T>): PromiseLike<T> },
  services: RunServices, input: RunInput, runId: string, step: Doc<'steps'>, call: { name: string; arguments: Record<string, unknown> },
  approved: boolean, signal: AbortSignal,
): Promise<ToolOutcome> {
  const wake = input.wakeEvents[0];
  const start = services.enqueuer.startBackgroundCall?.bind(services.enqueuer);
  if (wake === undefined || start === undefined) {
    return { kind: 'ran', result: { content: [{ type: 'text', text: 'Background execution is not available here; call ' + call.name + ' without background.' }], isError: true } };
  }
  const spawn = backgroundSpawnOf(wake, runId);
  const taskId = 'mcp-' + step.id;
  const decided = await ctx.run<ToolResult | null | boolean>('bg-start:' + step.id, async (): Promise<ToolResult | null> => {
    // Fresh check at effect time, as for a foreground call: a rule changed while approval was pending still blocks.
    let blocked: ToolResult | null;
    try {
      blocked = await freshRefusal(services, input, call.name, call.arguments, approved, signal);
    } catch (error) {
      if (signal.aborted) return refusal('The run stopped while checking the tool policy, so nothing was started.');
      throw error;
    }
    if (blocked !== null) return blocked;
    if ((await backgroundCapRefusal(services.store, input.conversationId, spawn)) !== undefined) {
      return { content: [{ type: 'text', text: BACKGROUND_LIMIT_TEXT + '; call ' + call.name + ' without background' }], isError: true };
    }
    try {
      await start({ taskId, ownerId: wake.ownerId, agentId: input.agentId, conversationId: input.conversationId, runId, toolName: call.name, arguments: recoveryArguments(call.arguments, true), wake, generation: spawn.generation });
    } catch {
      return { content: [{ type: 'text', text: 'The background task could not be started; retry, or call ' + call.name + ' without background.' }], isError: true };
    }
    await recordBackgroundTask(services.store, {
      id: taskId, ownerId: wake.ownerId, agentId: input.agentId, conversationId: input.conversationId, runId,
      kind: 'mcp', label: taskLabel(call.name), ...titleArg(call.arguments), notify: true, chainId: spawn.chainId, generation: spawn.generation,
      status: 'running', startedAt: new Date().toISOString(),
    });
    return null;
  });
  // A journal written before this check holds booleans (true started, false could not start); replay keeps those meanings.
  if (decided === false) return { kind: 'ran', result: { content: [{ type: 'text', text: 'The background task could not be started; retry, or call ' + call.name + ' without background.' }], isError: true } };
  if (decided !== null && decided !== true) return { kind: 'ran', result: decided };
  return { kind: 'ran', result: { content: [{ type: 'text', text: 'Started background task ' + taskId + ' (' + call.name + '). You will be woken with a task_done carrying its result.' }], details: { background: true, taskId } } };
}

export interface BackgroundCallDeps {
  store: Store;
  blobs: BlobStore;
  enqueuer: Enqueuer;
  toolRegistry: ToolRegistry;
}

interface CallState { done: boolean }

/** The issuing step id is embedded in the task id (`mcp-<stepId>`), so the fence lives on that step row. */
export function stepIdOfTask(taskId: string): string {
  return taskId.startsWith('mcp-') ? taskId.slice(4) : taskId;
}

/**
 * Run the call at most once and report it. The fence is runFencedTool's, written on the issuing step
 * row in the store (not in replayable object state): a restart mid-call is reported as interrupted and
 * never re-runs the external effect; a redelivery after the report is ignored. The result goes through
 * the same capture and redaction as a foreground result. A job the model stopped reports nothing.
 */
export async function runBackgroundCall(ctx: ToolRunContext & { key: string; done(): Promise<boolean>; markDone(): void; now(): PromiseLike<number>; sendWake(wake: WakeEvent): void }, deps: BackgroundCallDeps, input: BackgroundCallStart): Promise<void> {
  if (ctx.key !== input.taskId || input.wake.ownerId !== input.ownerId || input.wake.agentId !== input.agentId || input.wake.conversationId !== input.conversationId || (await ctx.done())) return;
  await inOwnerScope(input.ownerId, async () => {
    deps = { ...deps, store: deps.store.forOwner?.(input.ownerId) ?? deps.store };
    const target = { ownerId: input.ownerId, agentId: input.agentId, conversationId: input.conversationId, ...(input.wake.hop === undefined ? {} : { hop: input.wake.hop }) };
    const at = new Date(await ctx.now()).toISOString();
    const report = async (status: 'completed' | 'failed', text: string): Promise<void> => {
      ctx.markDone();
      const summary = await ctx.run('bg-summary', () => reportSummary(deps.store, { ownerId: input.ownerId, agentId: input.agentId, runId: input.runId, stepId: stepIdOfTask(input.taskId), tool: input.toolName }, text || '(no output)', SUMMARY_MAX));
      const task = await ctx.run('bg-end', () => endBackgroundTask(deps.store, input.taskId, status, at, oneLine(text || '(no output)')));
      // The model stopped this job: its result is dropped, the stop is already the record.
      if (task?.status === 'stopped') return;
      ctx.sendWake(taskDoneWake(target, { taskId: input.taskId, taskKind: 'mcp', status, summary, ...(input.generation === undefined ? {} : { generation: input.generation }), originRunId: input.runId }, at));
    };
    const step = await ctx.run('load-step', () => deps.store.get('steps', stepIdOfTask(input.taskId)));
    const tool = deps.toolRegistry.get(input.toolName);
    if (step === null || tool === undefined) return report('failed', 'Tool ' + input.toolName + ' is not available for this background task');
    if (step.runId !== input.runId) return;
    const stop = backgroundCancellation(deps.store, input.taskId);
    try {
      if (await stop.check()) { ctx.markDone(); return; }
      const fenced = await executeBackgroundAction(ctx, deps, input, step, tool, stop.cancellation);
      if (fenced.cancelled || await stop.check()) { ctx.markDone(); return; }
      await report(fenced.interrupted || fenced.result.isError === true ? 'failed' : 'completed', backgroundResultText(fenced.result));
    } finally {
      stop.close();
    }
  });
}

export const createBackgroundCallService = (deps: BackgroundCallDeps) =>
  object({
    name: 'BackgroundCall',
    handlers: {
      async call(ctx: ObjectContext, input: BackgroundCallStart): Promise<void> {
        await runBackgroundCall({
          key: ctx.key,
          rand: ctx.rand,
          run: (name, fn) => ctx.run(name, fn),
          done: async () => (await ctx.get<CallState>('state'))?.done === true,
          markDone: () => ctx.set('state', { done: true }),
          now: () => ctx.date.now(),
          sendWake: (wake) => sendCompletionWake(ctx, wake),
        }, deps, input);
      },
    },
  });

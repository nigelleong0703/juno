/**
 * One configured completion check, executed at most once (PH10).
 *
 * A check is a live side effect in the agent's bound sandbox, so it goes through the same fence as any
 * `replay:"never"` action: the fence is written before the command starts and its result is cached on
 * the check's own step. A crash mid-command therefore reports an interrupted check instead of running
 * the command again, and a stop that landed before the claim runs nothing at all. The fence and its
 * result are separate top-level `ctx.run` steps, never nested. Authorization is the same as any other
 * effect, so a `never`/`ask` permission stops the check rather than routing around it.
 */
import type { Doc, ToolContext, ToolResult } from '../../../contracts/index.js';
import type { TodoCheck } from '@agent-desktop/public-contracts';
import type { RunCancellation } from './cancel.js';
import { chargeEffect, checkBeforeEffect, type BudgetScope } from './model-budget.js';
import { stepAddedEvent, stepUpdatedEvent } from './agui-events.js';
import { interruptedResult, runFencedTool } from './replay.js';
import { evaluateToolPolicy, policyCallOf, readToolPolicyConfig } from './tool-policy.js';
import { boundedSummary, refusal } from './tool-projection.js';
import type { RunBudget } from './run-budget.js';
import type { RunContext, RunInput, RunServices } from './run-types.js';

/** A configured check never runs longer than this; a hung command cannot hold the run open. */
export const CHECK_TIMEOUT_MS = 20_000;

export interface CheckRunOutcome {
  passed: boolean;
  summary: string;
  /** True when the run budget (not the check itself) refused or interrupted the verification. */
  spent?: boolean;
}

function textOf(content: ToolResult['content']): string {
  return content.map((block) => (block.type === 'text' ? block.text : '[image]')).join('\n');
}

function contextFor(services: RunServices, input: RunInput, runId: string, signal: AbortSignal): ToolContext | null {
  const wake = input.wakeEvents[0];
  if (!wake) return null;
  return {
    ownerId: wake.ownerId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    runId,
    store: services.store,
    blobs: services.blobs,
    enqueuer: services.enqueuer,
    wake,
    step: async (_name, fn) => fn(),
    // The check's own deadline combined with the run's stop, so a stop aborts a cooperative command.
    signal,
  };
}

/**
 * The command action, bounded even when it ignores its abort signal: a native deadline race turns an
 * uncooperative hang into a definite failed result, which the fence caches so recovery cannot repeat
 * the command. Timing starts before the race and every branch (success, timeout, stop, throw)
 * carries the trusted elapsed time, so a 20s timeout is charged as 20s of active time instead of 0
 * and verification cannot silently continue on uncharged effects. This writes no store rows, so a
 * stop racing here performs no late writes.
 */
async function boundedAction(
  tool: { execute(args: unknown, context: ToolContext): Promise<ToolResult> },
  args: unknown,
  context: ToolContext,
  signal: AbortSignal,
): Promise<ToolResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<ToolResult>((resolve) => {
    onAbort = () => resolve(refusal('The run stopped while the check ran.'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const deadline = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(
      () => resolve(refusal('The check exceeded its ' + String(CHECK_TIMEOUT_MS / 1000) + 's bound.')),
      CHECK_TIMEOUT_MS,
    );
  });
  const startedAt = Date.now();
  const elapsed = (): number => Math.max(0, Date.now() - startedAt);
  try {
    const result = await Promise.race([tool.execute(args, context), deadline, stopped]);
    return { ...result, runtimeActiveMs: elapsed() };
  } catch (error) {
    const failed = refusal('The check could not run: ' + (error instanceof Error ? error.message : String(error)));
    return { ...failed, runtimeActiveMs: elapsed() };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/** The check's fenced step row, so the run shows what was verified and the fence has a durable home. */
function checkStep(runId: string, key: string, check: TodoCheck, ordinal: number): Doc<'steps'> {
  return {
    id: 'chk-' + key + '-' + check.id,
    runId,
    // A distinct band keeps these clear of the model tool steps and of the suspend keys.
    index: 800_000 + ordinal,
    kind: 'shell',
    verb: 'Verified',
    target: boundedSummary(check.spec),
    status: 'running',
    startedAt: new Date().toISOString(),
    durationMs: 0,
  };
}

/** The outcome of a cached or freshly observed result, matched against the configured expectation. */
function outcomeOf(result: ToolResult, check: TodoCheck): CheckRunOutcome {
  const full = textOf(result.content);
  const summary = boundedSummary(full);
  if (result.isError === true) return { passed: false, summary };
  if (check.kind === 'command' && check.expect !== undefined && !full.includes(check.expect)) {
    return { passed: false, summary: 'the output did not contain ' + JSON.stringify(check.expect) + ': ' + summary };
  }
  return { passed: true, summary };
}

/** Run one configured check. Every durable step here is top level; the fence owns its own steps. */
export async function runCheck(
  ctx: RunContext,
  services: RunServices,
  input: RunInput,
  runId: string,
  check: TodoCheck,
  key: string,
  ordinal: number,
  cancellation: RunCancellation,
  budget?: RunBudget,
): Promise<CheckRunOutcome> {
  if (cancellation.signal.aborted) return { passed: false, summary: 'the run stopped before the check ran' };
  const toolName = check.kind === 'command' ? 'shell.run' : 'files.read';
  const tool = services.toolRegistry.get(toolName);
  if (tool === undefined) return { passed: false, summary: 'no bound sandbox tool is available to run this check' };
  const scope: BudgetScope | undefined = budget === undefined ? undefined : { ctx, services, runId, budget };
  const chargeKey = 'check:' + key + ':' + check.id;
  if (scope !== undefined) {
    const pre = await checkBeforeEffect(scope, chargeKey);
    if (!pre.ok) return { passed: false, summary: 'the run budget is spent, so the check never ran: ' + pre.reason, spent: true };
  }
  const step = checkStep(runId, key, check, ordinal);
  await ctx.run(`check:${step.id}:create`, async () => {
    // Idempotent create: a present row keeps its fence/result cache, so a journal-less recovery
    // (or a repeated call on the same key) replays the cached outcome with zero new effects instead
    // of wiping the cache with a fresh running row and running the command again.
    if ((await services.store.get('steps', step.id)) !== null) return;
    await services.store.put('steps', step, { runId });
    await services.store.emit(stepAddedEvent(step));
  });
  const args = check.kind === 'command' ? { command: check.spec } : { path: check.spec };
  const policy = await ctx.run(`check:${step.id}:policy`, async () => {
    const ownerId = input.wakeEvents[0]?.ownerId ?? '';
    const config = await readToolPolicyConfig(
      services.store, services.toolRegistry, input.agentId, ownerId, cancellation.signal, policyCallOf(input, toolName, args),
    );
    return evaluateToolPolicy(config, toolName, input.wakeEvents[0], args);
  });
  if (policy.kind !== 'allow') {
    const why = policy.kind === 'ask'
      ? 'the policy asks before ' + toolName + (policy.ruleId?.startsWith('builtin.') === true ? ' (built-in rule ' + policy.ruleId + ')' : '') + ', so it cannot be verified unattended; use a check command that needs no approval'
      : policy.reason;
    return { passed: false, summary: 'the check was not allowed to run: ' + why };
  }
  const context = contextFor(services, input, runId, cancellation.signal);
  if (context === null) return { passed: false, summary: 'the run has no wake event to scope this check' };
  const fenced = await runFencedTool(
    ctx, services.store, step, toolName,
    () => boundedAction(tool, args, context, cancellation.signal), cancellation,
  );
  if (fenced.cancelled === true) {
    // A stop that landed mid-command leaves the step exactly as the fence left it: no late write may
    // reopen it as completed, and a genuine late result must never override the stopped step.
    return { passed: false, summary: 'the run stopped while the check ran' };
  }
  await ctx.run(`check:${step.id}:result`, async () => {
    const failed = fenced.interrupted || fenced.result.isError === true;
    const updated = await services.store.patch('steps', step.id, {
      status: failed ? 'failed' : 'completed',
      durationMs: Date.now() - Date.parse(step.startedAt),
      output: { summary: boundedSummary(textOf(fenced.result.content)) },
    });
    await services.store.emit(stepUpdatedEvent(updated));
  });
  if (scope !== undefined) {
    const charged = await chargeEffect(scope, chargeKey, fenced.result.runtimeActiveMs ?? 0);
    if (!charged.ok) return { passed: false, summary: 'the run budget ran out verifying the work: ' + charged.reason, spent: true };
  }
  if (fenced.interrupted) return { passed: false, summary: textOf(interruptedResult(toolName).content) };
  return outcomeOf(fenced.result, check);
}

import type { BackgroundCallStart, Doc, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import type { BackgroundCallDeps } from './background-call.js';
import type { RunCancellation } from './cancel.js';
import { bindLegacyFence, cacheFencedResult, interruptedReason, readExecution, runFencedTool, type FencedToolOutcome, type ToolRunContext } from './replay.js';
import { createRecoveryRetryStep, findPriorUnresolvedFence, markRetryCompleted, priorUnresolvedRecovery, recoveryActionSummary, recoveryArguments, recoveryFingerprint } from './recovery-ledger.js';
import { persistRecoveryRequest } from './recovery-review.js';
import { executeSafely, reconcileWithProjection } from './recovery-results.js';
import { backgroundResultText, reportSummary } from './output-capture.js';
import { projectResult, refusal } from './tool-projection.js';
import { freshRefusal } from './tool-policy.js';

const CALL_TIMEOUT_MS = 30 * 60_000;

/** The background object uses the same intent, review ledger and result checks as foreground calls. */
export async function executeBackgroundAction(ctx: ToolRunContext, deps: BackgroundCallDeps, input: BackgroundCallStart, step: Doc<'steps'>, tool: Tool, cancellation: RunCancellation): Promise<FencedToolOutcome> {
  const args = recoveryArguments(input.arguments, true);
  const binding = { ownerId: input.ownerId, agentId: input.agentId, conversationId: input.conversationId,
    ...(tool.origin === undefined ? {} : { connectionId: tool.origin.connectionId, ...(tool.origin.account === undefined ? {} : { account: tool.origin.account }) }) };
  const fingerprint = recoveryFingerprint(tool.name, args, binding, true);
  const runInput = { agentId: input.agentId, conversationId: input.conversationId, sessionKey: input.wake.sessionKey, wakeEvents: [input.wake] };
  const contextFor = (source: Doc<'steps'>): ToolContext => ({
    ...binding, runId: source.runId, stepId: source.id, store: deps.store, blobs: deps.blobs, enqueuer: deps.enqueuer, wake: input.wake,
    step: async (_name, fn) => fn(), signal: AbortSignal.any([AbortSignal.timeout(CALL_TIMEOUT_MS), cancellation.signal]),
  });
  const review = async (source: Doc<'steps'>, reason: string): Promise<FencedToolOutcome> => {
    if (await cancellation.peek()) { cancellation.abort(); return { interrupted: true, cancelled: true, result: refusal('The background task stopped.') }; }
    const request = await persistRecoveryRequest(ctx, deps.store, runInput, input.runId, step, tool.name, fingerprint, reason,
      recoveryActionSummary(tool.name, args, input.conversationId, source.startedAt), binding, source.id, true);
    return { interrupted: true, result: refusal(`The background action is uncertain and was not repeated. Check the durable owner review ${request.id}.`) };
  };
  const action = async (source: Doc<'steps'>): Promise<ToolResult> => {
    const context = contextFor(source);
    const blocked = await freshRefusal(deps, runInput, tool.name, args, true, context.signal);
    if (blocked !== null) return blocked;
    const raw = await executeSafely(tool, { name: tool.name, arguments: args }, context);
    if (await cancellation.peek()) { cancellation.abort(); return raw; }
    const summary = await reportSummary(deps.store, { ...binding, runId: source.runId, stepId: source.id, tool: tool.name }, backgroundResultText(raw), 2_000);
    return projectResult({ ...raw, content: [{ type: 'text', text: summary }] });
  };
  const reconcile = async (source: Doc<'steps'>) => {
    const evidence = await reconcileWithProjection(deps, tool, args, contextFor(source));
    if (await cancellation.peek()) cancellation.abort();
    return evidence;
  };
  // Read-only/background-safe calls retain their existing fence behavior without an owner review ledger.
  if (tool.sideEffect !== true || tool.replay !== 'never') {
    return runFencedTool(ctx, deps.store, step, tool.name, () => action(step), cancellation);
  }
  const semantic = await ctx.run('bg-semantic-check', () => priorUnresolvedRecovery(deps.store, input.agentId, fingerprint, step.id, tool.origin?.connectionId, tool.origin?.account));
  if (semantic.blocked !== undefined) return { interrupted: true, result: refusal('A previous action with these arguments is still uncertain. Its owner review remains open; no action was repeated.') };
  const prior = semantic.retryAuthorized ? undefined : await ctx.run('bg-prior-fence', () => findPriorUnresolvedFence(deps.store, input.agentId, step.id, fingerprint, input.ownerId, tool.name, input.conversationId, tool.origin?.connectionId, tool.origin?.account));
  const source = prior ?? step;
  const previous = readExecution(await deps.store.get('steps', source.id));
  const intent = { ...binding, tool: tool.name, fingerprint,
    ...(semantic.retryAuthorized ? { attempt: 1 } : previous?.intent?.attempt === undefined ? {} : { attempt: previous.intent.attempt }) };
  const legacy = await ctx.run('bg-bind-legacy:' + source.id, () => bindLegacyFence(deps.store, source, intent));
  if (legacy) return review(source, 'This historical background fence has no trustworthy saved operation identity or result. Its current action scope is recorded for owner review; it was not repeated.');
  const execute = (sourceStep: Doc<'steps'>, actionIntent: typeof intent) => runFencedTool(ctx, deps.store, sourceStep, tool.name, () => action(sourceStep), cancellation,
    tool.reconcile === undefined ? undefined : () => reconcile(sourceStep), actionIntent);
  let outcome = await execute(source, intent);
  if (outcome.cancelled) return outcome;
  if (outcome.interrupted && outcome.reconciliation?.status === 'not_executed') {
    const retry = await createRecoveryRetryStep(ctx, deps.store, source, input.runId);
    outcome = await execute(retry, { ...binding, tool: tool.name, fingerprint, attempt: 1 });
    if (!outcome.interrupted && !outcome.cancelled) await cacheFencedResult(deps.store, source, outcome.result);
  }
  if (outcome.cancelled) return outcome;
  if (outcome.interrupted) {
    const evidence = outcome.reconciliation;
    return review(source, evidence?.status === 'unknown' || evidence?.status === 'failed' ? evidence.reason : interruptedReason(tool.name));
  }
  await ctx.run('bg-retry-completed', () => markRetryCompleted(deps.store, input.agentId, fingerprint, step.id));
  return outcome;
}

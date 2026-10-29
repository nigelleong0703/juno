import { RestatePromise } from '@agent-desktop/durable';
import { TOOL_ORCHESTRATION_ACTIONS, type Doc, type Tool, type ToolBatchStepOutcome, type ToolContext, type ToolOrchestrationAction, type ToolOrchestrationOutcome, type ToolOrchestrationRuntime, type ToolResult } from '../../../contracts/index.js';
import { appendToTranscript, offloadImages, toolMessage } from '../../brain/index.js';
import { CANCELLED, NEVER_CANCELLED, type RunCancellation } from './cancel.js';
import { cacheFencedResult, interruptedReason, runFencedTool, type ToolRunContext } from './replay.js';
import { approvalReason, authorizeToolCall } from './tool-approval.js';
import { refuseChildOutbound } from '../../../modules/tasks/childDelivery.js';
import { freshRefusal, type ToolAuthorization, type ToolCallContext } from './tool-policy.js';
import { boundedSummary, projectResult, redactText, refusal, resultText, stepUpdate, type ToolOutcome } from './tool-projection.js';
import { captureOversizedResult } from './output-capture.js';
import { isBackgroundCall, startBackgroundCall } from './background-call.js';
import { appendRunStep } from './run-steps.js';
import {
  stepAddedEvent,
  stepUpdatedEvent,
  toolArgumentsWire,
  toolCallEndedEvent,
  toolCallResultEvent,
  toolCallStartedEvents,
  type WireScope,
} from './agui-events.js';
import { checkedCall, linkToRun, searchQueryOf } from './run-tool-check.js';
import { isPlumbingTool } from '../../../modules/tools/plumbing.js';
import type { RunContext, RunInput, RunServices } from './run-types.js';
import { awaitUser } from './run-input.js';
import { recoveryFingerprint, recoveryActionSummary, priorUnresolvedRecovery, findPriorUnresolvedFence, markRetryCompleted, recoveryArguments, historicalFenceSchema, createRecoveryRetryStep } from './recovery-ledger.js';
import { persistRecoveryRequest } from './recovery-review.js';
import { executeSafely, reconcileWithProjection } from './recovery-results.js';
export { findPriorUnresolvedFence } from './recovery-ledger.js';
import { words } from '../../../modules/mcp/tool-access.js';
import { copyPhrase } from '../../../modules/tools/tools/computerCopy.js';
import { buildToolContext } from './tool-context.js';
import { persistAdvanceHistory } from '../../../modules/tools/computer/browser-advance-history.js';
import { GOAL_BROWSER_NAMES } from '../../../modules/tools/tools/browserGoals.js';
import { BROWSER_ADVANCE_TOOL } from '../../../modules/tools/computer/browser-advance.js';
import { BATCH_ACTION_TOOLS, COMPUTER_BATCH_TOOL } from '../../../modules/tools/computer/batch.js';

/** A call by the tool it reaches. `wireName` is what the model called when that was the `tool_call` proxy (brain/tool-proxy.ts). */
type ToolCall = { id: string; name: string; arguments: Record<string, unknown>; wireName?: string };

/**
 * How a step reads in the chat. Web reads happen on the server and open nothing on the agent's screen,
 * so they must not read as "Executed"/"Opened": "Read <host>" and "Looked up <query>". A child_spawn reads
 * "Asked a helper <title>": the stored input summary is clipped and no longer parses, so the target carries the title.
 */
function stepLabel(call: ToolCall): { verb: string; target: string } {
  const arg = call.arguments;
  if ((call.name === BROWSER_ADVANCE_TOOL || call.name === 'browser.do') && typeof arg['goal'] === 'string') {
    return { verb: 'Advanced browser', target: arg['goal'].replace(/\s+/g, ' ').trim().slice(0, 120) };
  }
  if (call.name === COMPUTER_BATCH_TOOL && Array.isArray(arg['steps'])) return { verb: 'Ran', target: String(arg['steps'].length) + ' steps in a batch' };
  if (call.name === 'web_fetch' && typeof arg['url'] === 'string') {
    try {
      return { verb: 'Read', target: new URL(arg['url']).hostname };
    } catch {
      return { verb: 'Read', target: call.name };
    }
  }
  if (call.name === 'finish_quietly' && typeof arg['reason'] === 'string') return { verb: 'Finished quietly', target: arg['reason'].replace(/\s+/g, ' ').trim().slice(0, 120) };
  if (call.name === 'web_search' && typeof arg['query'] === 'string') return { verb: 'Looked up', target: arg['query'].slice(0, 60) };
  if (call.name === 'child_spawn') {
    const what = [arg['title'], arg['prompt']].find((v): v is string => typeof v === 'string' && v.trim() !== '');
    if (what !== undefined) return { verb: 'Asked a helper', target: what.replace(/\s+/g, ' ').trim().slice(0, 80) };
  }
  if (call.name === 'computer_copy' && typeof arg['path'] === 'string' && (arg['from'] === 'sandbox' || arg['from'] === 'mac') && (arg['to'] === 'sandbox' || arg['to'] === 'mac')) {
    return { verb: 'Copied', target: copyPhrase(arg['from'], arg['to'], arg['path']).slice(0, 120) };
  }
  return { verb: 'Executed', target: call.name };
}

/**
 * An MCP step reads "<Connector> · <tool title>" (the server's title when it gives one, else the tool's own name in
 * words), never the model-facing name. Null when the tool is not exposed (the plain label stays).
 */
async function mcpStepLabel(services: RunServices, agentId: string, name: string): Promise<{ verb: string; target: string } | null> {
  try {
    const origin = (await services.toolRegistry.forAgent(agentId)).find((tool) => tool.name === name)?.origin;
    if (origin === undefined) return null;
    const title = origin.title !== undefined && origin.title !== '' ? origin.title : words(origin.toolName).join(' ').replace(/^./, (first) => first.toUpperCase());
    return { verb: 'Executed', target: origin.connectionName + ' · ' + title };
  } catch {
    return null;
  }
}

/** A step id generated from `ctx.rand`, so it is stable across a replay and unique per tool call. */
function newStep(ctx: ToolRunContext, runId: string, stepIndex: number, toolIdx: number, call: ToolCall, identity?: { id: string; index: number }): Doc<'steps'> {
  const searched = searchQueryOf(call);
  return {
    id: identity?.id ?? `stp_${ctx.rand.uuidv4()}`,
    runId,
    index: identity?.index ?? stepIndex * 1000 + toolIdx,
    kind: 'mcp',
    tool: call.name,
    ...(isPlumbingTool(call.name) ? { internal: true } : {}),
    ...(searched === undefined ? {} : { searchQuery: searched }),
    ...stepLabel(call),
    status: 'running',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    // Before-hook projection: bounded and redacted, never the raw argument object.
    input: { summary: boundedSummary(call.arguments) },
  };
}

// Tool-facing context via the shared factory, so disclosure builds the identical context.
function toolContext(
  services: RunServices,
  input: RunInput,
  runId: string,
  wake: RunInput['wakeEvents'][number],
  signal: AbortSignal,
  stepId: string,
  disableAux = false,
  quiet = false,
): ToolContext {
  const built = buildToolContext(services, input, runId, wake, signal, stepId);
  // A computer.batch step: the browser tools skip their per-action snapshot (the batch observes once at the end).
  const context: ToolContext = quiet ? { ...built, quietObservation: true } : built;
  if (!disableAux) return context;
  // Nested actions cannot start hidden text generation or emulation. Native policy review
  // remains available; removing the reviewer made every ambiguous control fail closed.
  const rest: ToolContext = { ...context };
  delete rest.quickText;
  const reviewer = rest.systemOne;
  if (reviewer) rest.systemOne = { ask: (state, questions, signal, options) => reviewer.ask(state, questions, signal, { ...options, allowEmulation: false }) };
  return rest;
}

async function persistAndWaitForReconciliation(
  ctx: ToolCallContext, services: RunServices, input: RunInput, runId: string, step: Doc<'steps'>,
  toolName: string, fingerprint: string, reason: string, actionSummary: string, cancellation: RunCancellation,
  intent: { connectionId?: string; account?: string }, sourceStepId = step.id,
): Promise<ToolOutcome> {
  const ownerId = input.wakeEvents[0]?.ownerId;
  if (ownerId === undefined || ctx.awakeable === undefined || ctx.drainInbox === undefined) {
    return { kind: 'interrupted', result: { content: [{ type: 'text', text: `The outcome of ${toolName} is unknown and was not retried. A durable owner review could not be opened in this execution context.` }], isError: true } };
  }
  const request = await persistRecoveryRequest(ctx, services.store, input, runId, step, toolName, fingerprint, reason, actionSummary, intent, sourceStepId);
  const id = request.id;
  const waiting: RunContext = { rand: ctx.rand, run: ctx.run, awakeable: ctx.awakeable, drainInbox: ctx.drainInbox };
  const resumed = await awaitUser(waiting, services, input, runId, step.index + 700_000, { awakeableId: request.id }, cancellation, { appendAnswer: false });
  if (resumed === 'cancelled' || cancellation.state.cancelled) return { kind: 'cancelled' };
  const saved = await ctx.run(`recovery:${step.id}:decision`, () => services.store.get('requests', id));
  if (saved?.reconciliation?.state === 'user_reported_succeeded') {
    const result: ToolResult = { content: [{ type: 'text', text: `The owner reports that ${toolName} succeeded. This is a user report, not a verified external receipt; continue without repeating the action.` }], details: { reconciliation: { status: 'user_reported_succeeded', source: 'owner_report' } } };
    if (sourceStepId !== step.id) await ctx.run(`recovery:${sourceStepId}:owner-report`, async () => {
      const source = await services.store.get('steps', sourceStepId);
      if (source !== null) await cacheFencedResult(services.store, source, result);
    });
    return { kind: 'ran', result };
  }
  if (saved?.reconciliation?.state === 'user_confirmed_not_executed') {
    return { kind: 'ran', result: { content: [{ type: 'text', text: `The owner reports that ${toolName} did not happen and authorized one retry. Make the exact same call once; current permissions will be checked again.` }], details: { reconciliation: { status: 'retry_authorized', source: 'owner_report' } } } };
  }
  return { kind: 'interrupted', result: { content: [{ type: 'text', text: `${reason} The owner reports that the outcome is still unknown, so the action remains blocked and was not repeated.` }], isError: true, details: { reconciliation: { status: 'still_unknown', source: saved?.reconciliation?.source ?? 'owner_report' } } } };
}

async function runSeparatelyFencedRetry(
  ctx: ToolCallContext, services: RunServices, input: RunInput, runId: string, original: Doc<'steps'>,
  tool: Tool, call: ToolCall, cancellation: RunCancellation, fingerprint: string,
  binding: { ownerId: string; agentId: string; conversationId: string; connectionId?: string; account?: string },
): Promise<ToolOutcome> {
  const retryStep = await createRecoveryRetryStep(ctx, services.store, original, runId);
  const wake = input.wakeEvents[0];
  if (!wake) return { kind: 'cancelled' };
  const retryContext = toolContext(services, input, runId, wake, toolSignal(cancellation), retryStep.id);
  const retryIntent = { ...binding, tool: tool.name, fingerprint, attempt: 1 };
  const reconcile = tool.reconcile;
  const authorization = await authorizeToolCall(ctx, services, input, runId, retryStep, { name: tool.name, arguments: call.arguments }, cancellation);
  if (authorization.kind === 'cancelled') return { kind: 'cancelled' };
  if (authorization.kind === 'refuse') return { kind: 'refused', result: authorization.result };
  const outcome = await runFencedTool(
    ctx, services.store, retryStep, tool.name,
    () => guardedAction(services, input, retryStep, tool, call, retryContext, authorization.kind === 'allow' && authorization.approved), cancellation,
    reconcile === undefined ? undefined : () => reconcileWithProjection(services, tool, call.arguments, retryContext), retryIntent,
  );
  if (outcome.cancelled === true) return { kind: 'cancelled' };
  if (outcome.interrupted) return { kind: 'interrupted', result: outcome.result };
  // The retry step has no tool-call wire frames of its own, so only the step segment closes.
  await markStep(ctx, services, input, runId, retryStep, Date.now(), { kind: 'ran', result: outcome.result }, false);
  await cacheFencedResult(services.store, original, outcome.result);
  await ctx.run(`recovery:${original.id}:retry-completed`, () => markRetryCompleted(services.store, input.agentId, fingerprint, retryStep.id));
  return { kind: 'ran', result: outcome.result };
}

/** The 60s per-tool timeout, plus the run's cancellation signal so cooperative tools stop on a stop. */
function toolSignal(cancellation: RunCancellation): AbortSignal {
  return AbortSignal.any([cancellation.signal, AbortSignal.timeout(60_000)]);
}

/** The effect lambda: a fresh policy check, the action, then the bounded/redacted result. */
async function guardedAction(services: RunServices, input: RunInput, step: Doc<'steps'>, tool: Tool, call: ToolCall, context: ToolContext, approved: boolean): Promise<ToolResult> {
  // Fresh check at effect time: a rule or connection changed while an approval was pending still
  // blocks. A fenced result already cached by the replay fence skips this lambda entirely.
  let blocked: ToolResult | null;
  try {
    blocked = await freshRefusal(services, input, tool.name, call.arguments, approved, context.signal);
  } catch (error) {
    // A stop during tool discovery is a cancellation, not a policy failure: nothing was reviewed.
    if (context.signal.aborted) return refusal('The run stopped while checking the tool policy, so nothing was executed.');
    throw error;
  }
  if (blocked !== null) return blocked;
  // PH11: measure the authorized effect LOCALLY, inside the action, so the durable approval wait that
  // happened before it is never counted as active time (and a model-claimed duration is never trusted).
  const effectStartedAt = Date.now();
  // Capture BEFORE the projection bounds the result: an oversized body (or a private fullContent
  // detail) becomes a recoverable artifact and the model gets a real reference instead of a cut.
  const raw = await executeSafely(tool, call, context);
  const captured = await captureOversizedResult(
    services.store,
    { ownerId: context.ownerId, agentId: context.agentId, runId: context.runId, stepId: step.id, tool: tool.name },
    raw,
    context.signal,
  );
  return { ...projectResult(captured), runtimeActiveMs: Math.max(0, Date.now() - effectStartedAt) };
}

/** Run the authorized action through its durable path, or report the stop that beat it. */
async function executeCall(
  ctx: ToolRunContext,
  services: RunServices,
  input: RunInput,
  runId: string,
  step: Doc<'steps'>,
  call: ToolCall,
  target: { name: string; arguments: Record<string, unknown> },
  cancellation: RunCancellation,
  approved: boolean,
  disableAux = false,
  quiet = false,
  priorFence?: Doc<'steps'>,
  retryAuthorized = false,
): Promise<ToolOutcome> {
  const tool = services.toolRegistry.get(target.name);
  if (!tool) return { kind: 'ran', result: { content: [{ type: 'text', text: `Tool ${target.name} not found` }], isError: true } };
  // The inner arguments are what run; the outer name/id stay on the transcript message the model answers.
  const effectCall: ToolCall = { ...call, arguments: recoveryArguments(target.arguments, tool.mcp === true) };
  // H-73: authorized already; the effect-time policy re-check runs inside the journaled start step, as guardedAction does for a foreground call.
  if (isBackgroundCall({ arguments: target.arguments }, tool)) return startBackgroundCall(ctx, services, input, runId, step, { ...call, arguments: target.arguments }, approved, cancellation.signal);
  const wake = input.wakeEvents[0];
  if (!wake) throw new Error('No wake event available');
  const context = toolContext(services, input, runId, wake, toolSignal(cancellation), step.id, disableAux, quiet);

  // The action runs inside a durable step either way; a cooperative tool observes context.signal and
  // returns early, a non-cooperative one may finish late — the durable race is what stops the run.
  if (tool.replay === 'never' && tool.sideEffect) {
    const ownerId = wake.ownerId;
    const fingerprint = recoveryFingerprint(target.name, target.arguments, {
      ownerId, agentId: input.agentId, conversationId: input.conversationId,
      ...(tool.origin === undefined ? {} : { connectionId: tool.origin.connectionId, ...(tool.origin.account === undefined ? {} : { account: tool.origin.account }) }),
    }, tool.mcp === true);
    const intent = {
      ownerId,
      agentId: input.agentId,
      tool: target.name,
      fingerprint,
      conversationId: input.conversationId,
      ...(retryAuthorized ? { attempt: 1 } : {}),
      ...(tool.origin === undefined ? {} : { connectionId: tool.origin.connectionId, ...(tool.origin.account === undefined ? {} : { account: tool.origin.account }) }),
    };
    const reconcile = tool.reconcile;
    if (priorFence !== undefined) {
      const priorContext = toolContext(services, input, priorFence.runId, wake, toolSignal(cancellation), priorFence.id, disableAux, quiet);
      const priorParsed = historicalFenceSchema.safeParse(priorFence);
      const priorAttempt = priorParsed.success ? priorParsed.data.execution?.intent?.attempt : undefined;
      const priorIntent = { ...intent, ...(priorAttempt === undefined ? {} : { attempt: priorAttempt }) };
      if (reconcile === undefined) {
        return persistAndWaitForReconciliation(ctx, services, input, runId, step, target.name, fingerprint,
          `A previous run stopped after fencing ${target.name}; this tool has no safe read-only result check.`,
          recoveryActionSummary(target.name, target.arguments, input.conversationId, priorFence.startedAt), cancellation,
          { ...(tool.origin === undefined ? {} : { connectionId: tool.origin.connectionId, ...(tool.origin.account === undefined ? {} : { account: tool.origin.account }) }) }, priorFence.id);
      }
      const previous = await runFencedTool(
        ctx, services.store, priorFence, target.name,
        () => guardedAction(services, input, priorFence, tool, effectCall, priorContext, approved), cancellation,
        () => reconcileWithProjection(services, tool, target.arguments, priorContext), priorIntent,
      );
      if (previous.cancelled === true) return { kind: 'cancelled' };
      if (!previous.interrupted) return { kind: 'ran', result: previous.result };
      if (previous.reconciliation?.status !== 'not_executed') {
        const reason = previous.reconciliation?.status === 'unknown' || previous.reconciliation?.status === 'failed'
          ? previous.reconciliation.reason : interruptedReason(target.name);
        return persistAndWaitForReconciliation(ctx, services, input, runId, step, target.name, fingerprint, reason,
          recoveryActionSummary(target.name, target.arguments, input.conversationId, priorFence.startedAt), cancellation,
          { ...(tool.origin === undefined ? {} : { connectionId: tool.origin.connectionId, ...(tool.origin.account === undefined ? {} : { account: tool.origin.account }) }) }, priorFence.id);
      }
    }
    const fenced = await runFencedTool(
      ctx, services.store, step, target.name,
      () => guardedAction(services, input, step, tool, effectCall, context, approved),
      cancellation,
      reconcile === undefined ? undefined : () => reconcileWithProjection(services, tool, target.arguments, context),
      intent,
    );
    if (fenced.cancelled === true) return { kind: 'cancelled' };
    if (fenced.interrupted && fenced.reconciliation?.status === 'not_executed') {
      const retry = await runSeparatelyFencedRetry(ctx, services, input, runId, step, tool, effectCall, cancellation, fingerprint, intent);
      if (retry.kind !== 'interrupted') return retry;
      return persistAndWaitForReconciliation(ctx, services, input, runId, step, target.name, fingerprint, retry.result.content[0]?.type === 'text' ? retry.result.content[0].text : interruptedReason(target.name), recoveryActionSummary(target.name, target.arguments, input.conversationId, step.startedAt), cancellation, {
        ...(tool.origin === undefined ? {} : { connectionId: tool.origin.connectionId, ...(tool.origin.account === undefined ? {} : { account: tool.origin.account }) }),
      });
    }
    if (!fenced.interrupted) {
      await ctx.run(`recovery:${step.id}:retry-completed`, () => markRetryCompleted(services.store, input.agentId, fingerprint, step.id));
      return { kind: 'ran', result: fenced.result };
    }
    const evidence = fenced.reconciliation;
    const reason = evidence?.status === 'unknown' || evidence?.status === 'failed'
      ? evidence.reason
      : interruptedReason(target.name);
    return persistAndWaitForReconciliation(ctx, services, input, runId, step, target.name, fingerprint, reason, recoveryActionSummary(target.name, target.arguments, input.conversationId, step.startedAt), cancellation, {
      ...(tool.origin === undefined ? {} : { connectionId: tool.origin.connectionId, ...(tool.origin.account === undefined ? {} : { account: tool.origin.account }) }),
    });
  }
  const outcome = await cancellation.race(() => ctx.run(`tool:${step.id}`, () => guardedAction(services, input, step, tool, effectCall, context, approved)));
  return outcome === CANCELLED ? { kind: 'cancelled' } : { kind: 'ran', result: outcome };
}

async function markStep(
  ctx: ToolRunContext,
  services: RunServices,
  input: RunInput,
  runId: string,
  step: Doc<'steps'>,
  startedAt: number,
  outcome: ToolOutcome,
  wire: boolean,
): Promise<void> {
  await ctx.run(`step:${step.id}:update`, async () => {
    // patch (not put): never drop the execution fence/result cache written by runFencedTool.
    // An unknown tool counts as one that changes things, and so does any connected server's tool (its read-only hint is its own
    // word): only our own tools that just read are reported as "nothing changed".
    const stopped = step.tool === undefined ? undefined : services.toolRegistry.get(step.tool);
    const readOnly = stopped !== undefined && stopped.sideEffect === false && stopped.mcp !== true;
    const update = stepUpdate(outcome, step, startedAt, readOnly);
    // PH11: the duration is the trusted measured effect time; the approval wait before it is never charged.
    const activeMs = outcome.kind === 'ran' || outcome.kind === 'interrupted' ? outcome.result.runtimeActiveMs : undefined;
    const updated = await services.store.patch('steps', step.id, activeMs === undefined ? update : { ...update, durationMs: activeMs });
    await services.store.emit(stepUpdatedEvent(updated));
    if (wire) await services.store.emit(toolCallEndedEvent({ runId, conversationId: input.conversationId, agentId: input.agentId }, step.id));
    await appendRunStep(services.store, runId, updated);
  });
}

/**
 * One tool call through the authoritative durable path: the fresh policy decision (and any approval
 * wait) BEFORE the effect, its own step projection, a fence for a `replay:"never"` side effect, and
 * its tool-result transcript write. Returns the concrete result so a caller that owns the batch can
 * hand core the real result, or CANCELLED when a stop landed first.
 */
export async function executeSingleToolCall(
  ctx: ToolCallContext, services: RunServices, input: RunInput, runId: string, stepIndex: number, toolIdx: number,
  call: ToolCall, cancellation: RunCancellation = NEVER_CANCELLED, deliveredTexts: string[] = [],
): Promise<{ result: ToolResult; activeMs?: number } | typeof CANCELLED> {
  const prepared = await prepareCall(ctx, services, input, runId, stepIndex, toolIdx, call, cancellation);
  const tool = services.toolRegistry.get(prepared.target.name);
  const orchestrated = isOrchestratedName(prepared.target.name) && tool?.orchestrate !== undefined && prepared.authorization.kind === 'allow';
  const outcome = orchestrated
    ? await executeOrchestratedTool(ctx, services, input, runId, prepared, cancellation)
    : await startEffect(ctx, services, input, runId, prepared, cancellation);
  return finishCall(ctx, services, input, runId, prepared, outcome, deliveredTexts);
}

/** The built-in tools the harness runs through `orchestrate`: the browser helper, the goal browser tools and computer.batch. */
const isOrchestratedName = (name: string): boolean => name === BROWSER_ADVANCE_TOOL || name === COMPUTER_BATCH_TOOL || GOAL_BROWSER_NAMES.some(goal => goal === name);

type StepIdentity = { id: string; index: number };
type PreparedCall = {
  call: ToolCall;
  target: { name: string; arguments: Record<string, unknown> };
  step: Doc<'steps'>;
  startedAt: number;
  authorization: ToolAuthorization;
  /** False for a nested orchestration/batch step: only a model-requested call is a standard TOOL_CALL segment. */
  wire: boolean;
  priorFence?: Doc<'steps'>;
  retryAuthorized: boolean;
};

/**
 * Step row, child boundary and the policy decision (with any approval wait), journaled in call order. The call already names
 * the tool it reaches (a `tool_call` proxy was unwrapped where the reply was received), so the step, the policy check and
 * any approval all run under that tool's own name: a hidden action asks exactly as it would directly.
 */
async function prepareCall(
  ctx: ToolCallContext, services: RunServices, input: RunInput, runId: string, stepIndex: number, toolIdx: number,
  modelCall: ToolCall, cancellation: RunCancellation, identity?: StepIdentity,
): Promise<PreparedCall> {
  // The argument boundary: optional "" / blank / null are left out, and a call that does not fit the tool's schema never asks for approval.
  const { call, invalid } = checkedCall(services, input, runId, modelCall);
  const target = { name: call.name, arguments: call.arguments };
  const draft = newStep(ctx, runId, stepIndex, toolIdx, call, identity);
  const label = services.toolRegistry.get(target.name)?.mcp === true ? await ctx.run(`step-label:${draft.id}`, () => mcpStepLabel(services, input.agentId, target.name)) : null;
  const links = await ctx.run(`step-links:${draft.id}`, () => linkToRun(services, runId, draft));
  const step = { ...draft, ...(label ?? {}), ...links };
  const wire = identity === undefined;
  const scope: WireScope = { runId, conversationId: input.conversationId, agentId: input.agentId };
  await ctx.run(`step:${step.id}:create`, async () => {
    await services.store.put('steps', step, { runId });
    await services.store.emit(stepAddedEvent(step));
    if (wire) {
      for (const event of toolCallStartedEvents(scope, step.id, target.name, toolArgumentsWire(target.arguments))) {
        await services.store.emit(event);
      }
    }
  });
  const startedAt = Date.now();
  // CT: the canonical boundary decision is journalled, so a replay re-derives the same refusal.
  const bypass = await ctx.run(`child-boundary:${step.id}`, () => refuseChildOutbound(services, runId, target.name));
  const tool = services.toolRegistry.get(target.name);
  const ownerId = input.wakeEvents[0]?.ownerId ?? '';
  const fingerprint = recoveryFingerprint(target.name, target.arguments, {
    ownerId, agentId: input.agentId, conversationId: input.conversationId,
    ...(tool?.origin === undefined ? {} : { connectionId: tool.origin.connectionId, ...(tool.origin.account === undefined ? {} : { account: tool.origin.account }) }),
  }, tool?.mcp === true);
  const recovery = invalid === null && bypass === null && tool?.replay === 'never' && tool.sideEffect
    ? await ctx.run(`recovery:${step.id}:semantic-check`, () => priorUnresolvedRecovery(
      services.store, input.agentId, fingerprint, step.id, tool.origin?.connectionId, tool.origin?.account,
    ))
    : { retryAuthorized: false };
  const priorFence = recovery.blocked === undefined && !recovery.retryAuthorized && invalid === null && bypass === null && tool?.replay === 'never' && tool.sideEffect
    ? await ctx.run(`recovery:${step.id}:prior-fence`, () => findPriorUnresolvedFence(services.store, input.agentId, step.id, fingerprint, ownerId, target.name, input.conversationId, tool.origin?.connectionId, tool.origin?.account))
    : undefined;
  const refused = invalid ?? bypass ?? (recovery.blocked === undefined ? null : refusal(`A previous ${recovery.blocked.reconciliation?.tool ?? target.name} action with these exact arguments still has an unknown outcome. It is blocked until trusted evidence resolves it; the owner's card decision is not success evidence.`));
  const authorization: ToolAuthorization = refused === null ? await authorizeToolCall(ctx, services, input, runId, step, target, cancellation) : { kind: 'refuse', result: refused };
  return { call, target, step, startedAt, authorization, wire, ...(priorFence === undefined ? {} : { priorFence }), retryAuthorized: recovery.retryAuthorized };
}

/**
 * The effect. Not `async` on purpose: for an allowed call the durable `tool:<step>` entry is created
 * synchronously when this is called, so a batch that starts several effects in call order journals
 * them in that same order on every replay.
 */
function startEffect(ctx: ToolCallContext, services: RunServices, input: RunInput, runId: string, prepared: PreparedCall, cancellation: RunCancellation): Promise<ToolOutcome> {
  const { authorization } = prepared;
  if (authorization.kind === 'cancelled') return Promise.resolve({ kind: 'cancelled' });
  if (authorization.kind === 'refuse') return Promise.resolve({ kind: 'refused', result: authorization.result });
  return executeCall(ctx, services, input, runId, prepared.step, prepared.call, prepared.target, cancellation, authorization.kind === 'allow' && authorization.approved, false, false, prepared.priorFence, prepared.retryAuthorized);
}

/** The complete child-name allowlist for the one orchestrated browser tool. */
const ORCHESTRATED_BROWSER_TOOLS: Readonly<Record<ToolOrchestrationAction, string>> = {
  navigate: 'browser.navigate',
  scroll: 'browser.scroll',
  snapshot: 'browser.snapshot',
  click: 'browser.click',
  type: 'browser.type',
  fill: 'browser.fill',
  get_text: 'browser.get_text',
};
const ORCHESTRATED_BROWSER_ACTIONS: ReadonlySet<string> = new Set(TOOL_ORCHESTRATION_ACTIONS);

/** One nested action through prepare/authorize/effect/finish, with no child tool-result transcript row. */
async function executeBrowserAdvanceChild(
  ctx: ToolCallContext,
  services: RunServices,
  input: RunInput,
  runId: string,
  parent: PreparedCall,
  action: ToolOrchestrationAction,
  actionArgs: Record<string, unknown>,
  childIndex: number,
  cancellation: RunCancellation,
): Promise<{ result: ToolResult } | typeof CANCELLED> {
  if (!ORCHESTRATED_BROWSER_ACTIONS.has(action)) throw new Error('Browser orchestration action is not allowlisted: ' + action);
  const name = ORCHESTRATED_BROWSER_TOOLS[action];
  const call: ToolCall = { id: parent.call.id + ':advance:' + String(childIndex), name, arguments: actionArgs };
  const identity: StepIdentity = { id: parent.step.id + ':advance:' + String(childIndex), index: parent.step.index };
  const prepared = await prepareCall(ctx, services, input, runId, 0, 0, call, cancellation, identity);
  let outcome: ToolOutcome;
  if (prepared.authorization.kind === 'cancelled') return CANCELLED;
  if (prepared.authorization.kind === 'refuse') outcome = { kind: 'refused', result: prepared.authorization.result };
  else {
    outcome = await executeCall(
      ctx, services, input, runId, prepared.step, prepared.call, prepared.target, cancellation,
      prepared.authorization.kind === 'allow' && prepared.authorization.approved, true,
    );
  }
  const finished = await finishCall(ctx, services, input, runId, prepared, outcome, [], true);
  return finished === CANCELLED ? CANCELLED : { result: finished.result };
}

/**
 * One computer.batch step as its own canonical call: the same preparation as a single call (argument check, child boundary,
 * policy), its own step row, fence and journal, and no tool-result transcript row. The only difference from a single call is
 * the approval: a step the policy would ask about is not started and not asked, the batch stops before it
 * ("needs approval"), and the model makes that one call on its own, which raises the normal approval card.
 */
async function executeBatchChild(
  ctx: ToolCallContext,
  services: RunServices,
  input: RunInput,
  runId: string,
  parent: PreparedCall,
  name: string,
  args: Record<string, unknown>,
  childIndex: number,
  cancellation: RunCancellation,
): Promise<ToolBatchStepOutcome> {
  if (!BATCH_ACTION_TOOLS.includes(name)) throw new Error('Batch step is not allowlisted: ' + name);
  const identity: StepIdentity = { id: parent.step.id + ':batch:' + String(childIndex), index: parent.step.index };
  const call: ToolCall = { id: parent.call.id + ':batch:' + String(childIndex), name, arguments: args };
  // The same argument boundary prepareCall applies, so the policy is asked about the arguments that would run.
  const { call: checked, invalid } = checkedCall(services, input, runId, call);
  if (invalid === null) {
    let reason: string | null;
    try {
      reason = await approvalReason(ctx, services, input, identity.id, checked, cancellation);
    } catch (error) {
      if (cancellation.state.cancelled || cancellation.signal.aborted) return { kind: 'cancelled' };
      throw error;
    }
    if (reason !== null) return { kind: 'needs_approval', reason };
  }
  const prepared = await prepareCall(ctx, services, input, runId, 0, 0, checked, cancellation, identity);
  let outcome: ToolOutcome;
  if (prepared.authorization.kind === 'cancelled') return { kind: 'cancelled' };
  if (prepared.authorization.kind === 'refuse') outcome = { kind: 'refused', result: prepared.authorization.result };
  else {
    outcome = await executeCall(
      ctx, services, input, runId, prepared.step, prepared.call, prepared.target, cancellation,
      prepared.authorization.kind === 'allow' && prepared.authorization.approved, false, true,
    );
  }
  const finished = await finishCall(ctx, services, input, runId, prepared, outcome, [], true);
  return finished === CANCELLED ? { kind: 'cancelled' } : { kind: 'ran', result: finished.result, stepId: prepared.step.id };
}

/**
 * Run the one allowlisted orchestrated tool AFTER its outer authorization, outside every outer
 * `ctx.run`/fence. Native decisions are journaled; every child owns its own canonical fence.
 */
async function executeOrchestratedTool(
  ctx: ToolCallContext,
  services: RunServices,
  input: RunInput,
  runId: string,
  prepared: PreparedCall,
  cancellation: RunCancellation,
): Promise<ToolOutcome> {
  if (prepared.authorization.kind === 'cancelled') return { kind: 'cancelled' };
  if (prepared.authorization.kind === 'refuse') return { kind: 'refused', result: prepared.authorization.result };
  const tool = services.toolRegistry.get(prepared.target.name);
  // Strict built-in name + method check. A stored/custom tool named browser.advance is not supplied
  // this path unless its instance has the contract method too, and only its own nested dispatcher
  // can reach the fixed browser.* allowlist.
  if (!isOrchestratedName(prepared.target.name) || tool?.orchestrate === undefined) {
    return { kind: 'ran', result: { content: [{ type: 'text', text: 'Browser orchestration is unavailable.' }], isError: true } };
  }
  const wake = input.wakeEvents[0];
  if (!wake) throw new Error('No wake event available');
  const isBatch = prepared.target.name === COMPUTER_BATCH_TOOL;
  // A batch of up to a dozen steps may outlast one tool's 60s limit (each step has its own); only a stop ends it.
  const context = toolContext(services, input, runId, wake, isBatch ? cancellation.signal : toolSignal(cancellation), prepared.step.id);
  const startedAt = Date.now();
  let childIndex = 0;
  // The first outer decision waited on approval. Re-check the current rule/exposure before any
  // native call or child action; the outer orchestration has no effect fence of its own.
  let outerRefusal: ToolResult | null;
  try {
    outerRefusal = await ctx.run('advance:' + prepared.step.id + ':outer-fresh', () => freshRefusal(
      services, input, prepared.target.name, prepared.call.arguments, prepared.authorization.kind === 'allow' && prepared.authorization.approved, context.signal,
    ));
  } catch (error) {
    if (cancellation.state.cancelled || context.signal.aborted) return { kind: 'cancelled' };
    throw error;
  }
  if (outerRefusal !== null) return { kind: 'refused', result: outerRefusal };
  const runtime: ToolOrchestrationRuntime = {
    signal: context.signal,
    journal: <T>(key: string, action: () => Promise<T>): Promise<T> => ctx.run('advance:' + prepared.step.id + ':' + key, action),
    run: async (action: ToolOrchestrationAction, args: Record<string, unknown>): Promise<ToolOrchestrationOutcome> => {
      childIndex += 1;
      const child = await executeBrowserAdvanceChild(ctx, services, input, runId, prepared, action, args, childIndex, cancellation);
      return child === CANCELLED ? { kind: 'cancelled' } : { kind: 'completed', result: child.result };
    },
    ...(isBatch ? {
      runTool: async (name: string, args: Record<string, unknown>): Promise<ToolBatchStepOutcome> => {
        childIndex += 1;
        return executeBatchChild(ctx, services, input, runId, prepared, name, args, childIndex, cancellation);
      },
    } : {}),
  };
  try {
    const outcome = await tool.orchestrate(prepared.call.arguments, context, runtime);
    if (outcome.kind === 'cancelled' || cancellation.state.cancelled) return { kind: 'cancelled' };
    // The final projected result and trusted active time are one durable record: a replay must not
    // charge a fresh effect duration or re-derive a different summary after later child steps.
    const final = await ctx.run('advance:' + prepared.step.id + ':final', async () => {
      const projected = projectResult(outcome.result);
      const activeMs = Math.max(0, Date.now() - startedAt);
      return { result: { ...projected, runtimeActiveMs: activeMs }, activeMs };
    });
    return { kind: 'ran', result: final.result };
  } catch (error) {
    if (cancellation.state.cancelled || context.signal.aborted) return { kind: 'cancelled' };
    const text = error instanceof Error ? error.message : String(error);
    return { kind: 'ran', result: projectResult({ content: [{ type: 'text', text: (isBatch ? 'The batch failed: ' : 'Browser advancement failed: ') + text }], isError: true }) };
  }
}

/** Step update, delivered-text bookkeeping and the tool-result transcript row, in call order. */
async function finishCall(
  ctx: ToolCallContext, services: RunServices, input: RunInput, runId: string, prepared: PreparedCall, outcome: ToolOutcome, deliveredTexts: string[],
  suppressTranscript = false,
): Promise<{ result: ToolResult; activeMs?: number } | typeof CANCELLED> {
  const { call, step, startedAt } = prepared;
  await markStep(ctx, services, input, runId, step, startedAt, outcome, prepared.wire);
  if (outcome.kind === 'cancelled') return CANCELLED;
  const { result } = outcome;
  // A tool that already showed the user its text records it here, so the automatic final reply is
  // never posted on top of it: genuinely new results must go out through another explicit
  // send_message call instead of the final text. Only this run's conversation suppresses its reply.
  const delivered = result.details?.deliveredText;
  const deliveredConv = result.details?.deliveredConversationId;
  const current = typeof deliveredConv !== 'string' || deliveredConv === input.conversationId;
  if (current && typeof delivered === 'string' && !deliveredTexts.includes(delivered)) deliveredTexts.push(delivered);
  if (!suppressTranscript) {
    await ctx.run(`tool-result:${step.id}`, async () => {
      const entries = await appendToTranscript(services.store, input.sessionKey, [await offloadImages(services.blobs, toolMessage(call.wireName ?? call.name, call.id, result))], step.id);
      if (prepared.target.name === BROWSER_ADVANCE_TOOL) await persistAdvanceHistory(services.store, entries, result, { ownerId: input.wakeEvents[0]?.ownerId ?? '', agentId: input.agentId, runId, stepId: step.id });
      if (prepared.wire) {
        await services.store.emit(toolCallResultEvent({ runId, conversationId: input.conversationId, agentId: input.agentId }, step.id, redactText(resultText(result))));
      }
    });
  }
  // The core charges the active budget from this measured value AFTER the effect (never during it).
  return { result, ...(result.runtimeActiveMs === undefined ? {} : { activeMs: result.runtimeActiveMs }) };
}

/** The durable effect entry of an allowed read-only call (same name as the single-call path), not awaited here. */
function effectEntry(ctx: ToolCallContext, services: RunServices, input: RunInput, runId: string, prepared: PreparedCall, cancellation: RunCancellation) {
  const { step, call, target, authorization } = prepared;
  const tool = services.toolRegistry.get(target.name);
  const wake = input.wakeEvents[0];
  if (!tool || !wake) throw new Error('parallel tool call without a tool or wake event: ' + target.name);
  const context = toolContext(services, input, runId, wake, toolSignal(cancellation), step.id);
  const effectCall: ToolCall = { ...call, arguments: recoveryArguments(target.arguments, tool.mcp === true) };
  return ctx.run(`tool:${step.id}`, () => guardedAction(services, input, step, tool, effectCall, context, authorization.kind === 'allow' && authorization.approved));
}

/**
 * Codex's parallel tool runtime (core/src/tools/parallel.rs): a tool that supports parallel calls takes
 * the read lock and runs alongside its neighbours, any other takes the write lock and runs alone.
 * Here "supports parallel" is a read-only tool (no side effect) that is not a background start.
 */
export function supportsParallel(services: RunServices, call: ToolCall): boolean {
  const tool = services.toolRegistry.get(call.name);
  return tool !== undefined && tool.sideEffect === false && !isBackgroundCall(call, tool);
}

/**
 * A run of consecutive read-only calls from one model response, executed concurrently. Durable and
 * replay-stable: every call is prepared (step, boundary, policy) in call order, every effect entry is
 * then created in call order with no await in between, they settle together, and steps plus
 * tool-result transcript rows are written back in call order (Codex collects results with
 * FuturesOrdered the same way), so the history never depends on which effect finished first.
 */
export async function executeParallelToolCalls(
  ctx: ToolCallContext, services: RunServices, input: RunInput, runId: string, stepIndex: number,
  calls: Array<{ toolIdx: number; call: ToolCall }>, cancellation: RunCancellation = NEVER_CANCELLED, deliveredTexts: string[] = [],
): Promise<Array<{ result: ToolResult; activeMs?: number } | typeof CANCELLED>> {
  const prepared: PreparedCall[] = [];
  for (const entry of calls) prepared.push(await prepareCall(ctx, services, input, runId, stepIndex, entry.toolIdx, entry.call, cancellation));
  // Restate allows one pending await per handler: the effects are combined with RestatePromise.all and
  // raced against the stop ONCE (awaiting several SDK promises with native Promise.all fails with
  // "awaitNext already pending"). Entries are created in call order, under the same `tool:<step>`
  // names as the single-call path, so a replay matches either way.
  const allowed = prepared.filter((item) => item.authorization.kind === 'allow');
  const settled = allowed.length === 0
    ? []
    : await cancellation.race(() => RestatePromise.all(allowed.map((item) => effectEntry(ctx, services, input, runId, item, cancellation))));
  const byStep = new Map<string, ToolResult>();
  if (settled !== CANCELLED) allowed.forEach((item, index) => { const result = settled[index]; if (result !== undefined) byStep.set(item.step.id, result); });
  const outcomes: ToolOutcome[] = prepared.map((item): ToolOutcome => {
    if (item.authorization.kind === 'cancelled') return { kind: 'cancelled' };
    if (item.authorization.kind === 'refuse') return { kind: 'refused', result: item.authorization.result };
    const result = byStep.get(item.step.id);
    return result === undefined ? { kind: 'cancelled' } : { kind: 'ran', result };
  });
  const results: Array<{ result: ToolResult; activeMs?: number } | typeof CANCELLED> = [];
  for (let index = 0; index < prepared.length; index += 1) {
    const item = prepared[index];
    const outcome = outcomes[index];
    if (item === undefined || outcome === undefined) continue;
    results.push(await finishCall(ctx, services, input, runId, item, outcome, deliveredTexts));
  }
  return results;
}

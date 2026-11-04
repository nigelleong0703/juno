/** Recovery for one durable model turn: bounded retries, one compaction, truthful budget blocks. */
import { cacheReadMetrics } from '../../../brain/request-cache.js';
import { TerminalError } from '@agent-desktop/durable';
import { LIMITS, type AssistantTurn, type BrainContext, type ModelCallStats, type Tool } from '../../../../contracts/index.js';
import { BUDGET_EXHAUSTED, COMPACTION_THRASH, compactAndRefresh, recentlyCompacted, type CompactionLog } from './turn-context.js';
import { parseModelSnapshot, toTerminalModelError, withFallbackModel } from '../../../brain/model-selection.js';
import { ProviderFailureError, type ProviderFailure } from '../../../brain/model-failure.js';
import { ModelTurnError } from '../../../brain/model-turn-error.js';
import type { RunBudget } from '../../services/run-budget.js';
import { chargeCompactionStep, chargeFailedAttemptStep } from '../../services/model-budget.js';
import { CANCELLED, type RunCancellation } from '../../services/cancel.js';
import type { RunContext, RunInput, RunServices } from '../../services/run-types.js';
import type { LiveRunEvent } from '../../../../contracts/index.js';
import { plainProviderFailure } from '../../logic/plain-errors.js';

// Turn-context preparation lives in turn-context.ts; re-exported so existing import paths hold.
export { BUDGET_EXHAUSTED, COMPACTION_THRASH, guardModelSelection, prepareTurnContext } from './turn-context.js';

/** Transient (and quota) retries allowed on the primary model before the fallback, then a truthful failure. */
export const MAX_TRANSIENT_ATTEMPTS = 2;
/** Exponential backoff before a retry: RETRY_BASE_MS doubling per retry, capped at RETRY_CAP_MS. */
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 8_000;
/** An announced retry-after longer than this is not slept inside the run; the step moves on instead. */
const RETRY_AFTER_CAP_MS = 30_000;

/** Bounded recovery budget for one step: retry count, whether the overflow compaction ran, and the fallback switch. */
export interface RecoveryBudget {
  transient: number;
  compacted: boolean;
  /** Once true the step has moved to the fallback model; the switch is sticky for the rest of the run. */
  fellBack?: boolean;
}

/**
 * Delay before the next retry, or undefined when an announced retry-after is too long to sleep through.
 * The jitter is a hash of the attempt's seed, so a replay computes the same delay (no Math.random).
 */
export function retryDelayMs(retryIndex: number, retryAfterMs: number | undefined, seed: string): number | undefined {
  if (retryAfterMs !== undefined) return retryAfterMs <= RETRY_AFTER_CAP_MS ? retryAfterMs : undefined;
  const exponential = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** retryIndex);
  return Math.round(exponential * (0.5 + jitterOf(seed) / 2));
}

/** FNV-1a of the seed mapped into [0, 1). */
function jitterOf(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

/** Durable sleep raced with the run's cancel; false when the run was cancelled during the wait. */
async function backoff(options: RecoverModelOptions, delayMs: number): Promise<boolean> {
  const sleep = options.ctx.sleep;
  // A test double may omit the durable sleep; the retry then runs at once.
  if (sleep === undefined || delayMs <= 0) return true;
  return (await options.cancellation.race(() => sleep(delayMs))) !== CANCELLED;
}

/** What one durable model attempt recorded; a classified failure is data, never a rejected step. */
type ModelStepOutcome =
  | { kind: 'turn'; turn: AssistantTurn; durationMs?: number }
  | { kind: 'provider_failure'; failure: ProviderFailure }
  | { kind: 'terminal'; code: string; message: string };

export interface RecoverModelOptions {
  ctx: RunContext;
  services: RunServices;
  input: RunInput;
  stepIndex: number;
  runId: string;
  brainCtx: BrainContext;
  tools: Tool[];
  cancellation: RunCancellation;
  recovery: RecoveryBudget;
  /** The steps of this run that compacted: the overflow compaction counts there too, and is refused when it would be the second one in a few steps. */
  compactions: CompactionLog;
  /** The run's frozen budget, so a compaction's measured cost is charged outside its durable step. */
  budget: RunBudget;
  /** Called after each attempt, OUTSIDE its durable action, with what it cost and how long it ran. */
  onAttempt?: (key: string, outcome: ModelStepOutcome, durationMs: number) => Promise<void>;
}

/** The result of one recovered model step: the turn and the context the next step should use. */
export interface RecoveredModelStep {
  turn: AssistantTurn;
  brainCtx: BrainContext;
  /** Measured inside the journaled action; 0 when an older journal recorded no duration. */
  durationMs: number;
  /** Journal-stable key of the attempt that produced the turn; the success charge uses it. */
  key: string;
}

/** One raw provider attempt; permanent failures keep their type for the journaled serialization. */
async function callProvider(options: RecoverModelOptions, onStats: (stats: ModelCallStats) => void, onDelta: (delta: string) => void): Promise<AssistantTurn> {
  const { services, brainCtx, tools, cancellation } = options;
  return services.brain.step(brainCtx, tools, {
    signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(LIMITS.run.maxActiveSeconds * 1000)]),
    onStats,
    onDelta,
  });
}

/**
 * Live text of ONE live model attempt (a journaled replay never runs this): a reset first, then each text delta as the provider
 * streams it, then the end of the turn with its tool-call count. Published to the in-process live channel (`services.live`), which is
 * synchronous and ordered, so a slow consumer cannot reorder text. A publish failure is logged and never fails the turn: the durable
 * reply item is still the source of truth. No owner or no channel (a deployment that serves no live text): nothing is published.
 */
function liveAttemptOf(options: RecoverModelOptions, attempt: string): { reset(): void; onDelta(delta: string): void; end(toolCalls: number): void } {
  const { services, input, runId } = options;
  const ownerId = input.wakeEvents[0]?.ownerId;
  const live = services.live;
  const scope = { ownerId: ownerId ?? '', conversationId: input.conversationId, agentId: input.agentId, runId, attempt };
  const publish = (event: LiveRunEvent): void => {
    if (ownerId === undefined || live === undefined) return;
    try {
      live.publish(event);
    } catch (error) {
      services.log?.({ runId, attempt, error: error instanceof Error ? error.message : String(error) }, 'live run text not published');
    }
  };
  return {
    reset: () => publish({ ...scope, type: 'run.text.reset' }),
    onDelta: (delta) => publish({ ...scope, type: 'run.text.delta', text: delta }),
    end: (toolCalls) => publish({ ...scope, type: 'run.text.end', toolCalls }),
  };
}

/**
 * One `model call` log line per real provider attempt (a replay never runs the action, so never logs):
 * where the time went and the token counts. No prompt content and no credentials.
 */
function logModelCall(options: RecoverModelOptions, key: string, outcome: ModelStepOutcome, durationMs: number, stats: ModelCallStats | undefined): void {
  const log = options.services.log;
  if (log === undefined) return;
  const turn = outcome.kind === 'turn' ? outcome.turn : undefined;
  const snapshot = parseModelSnapshot(options.brainCtx);
  log({
    runId: options.runId,
    step: options.stepIndex,
    attempt: key,
    model: snapshot?.modelId,
    // The reasoning level this call sent: a level, `omit` (none sent), or absent when the model takes no control.
    effort: snapshot?.controls?.reasoningEffort ?? (snapshot?.controls?.omitReasoning === true ? 'omit' : undefined),
    outcome: outcome.kind === 'provider_failure' ? outcome.failure.kind : outcome.kind,
    durationMs,
    ...stats,
    ...(turn === undefined ? {} : {
      ...cacheReadMetrics(turn.usage),
      inputTokens: turn.usage.inputTokens,
      cachedTokens: turn.usage.cacheReadTokens ?? 0,
      cacheWriteTokens: turn.usage.cacheWriteTokens ?? 0,
      outputTokens: turn.usage.outputTokens,
      toolCalls: turn.toolCalls.length,
      stopReason: turn.stopReason,
    }),
  }, 'model call');
}

/**
 * Journal one attempt as a serialized outcome, so the durable step FULFILS for every typed failure:
 * a real run caches the outcome, replays it instead of re-calling the provider, and the outer loop —
 * not the runtime — decides the retry. Only an unclassified error stays a rejected step.
 */
/** One journaled attempt: its outcome plus the duration measured inside its own action. */
interface JournaledAttempt {
  outcome: ModelStepOutcome;
  durationMs: number;
}

async function serializeAttempt(options: RecoverModelOptions, key: string): Promise<JournaledAttempt> {
  let measured: ModelCallStats | undefined;
  const live = liveAttemptOf(options, key);
  // Reset first, so a consumer of a retried attempt drops whatever partial text the failed one streamed.
  live.reset();
  const attempt = await runAttempt(options, (stats) => { measured = stats; }, live.onDelta);
  if (attempt.outcome.kind === 'turn') live.end(attempt.outcome.turn.toolCalls.length);
  logModelCall(options, key, attempt.outcome, attempt.durationMs, measured);
  return attempt;
}

async function runAttempt(options: RecoverModelOptions, onStats: (stats: ModelCallStats) => void, onDelta: (delta: string) => void): Promise<JournaledAttempt> {
  // A plain local clock: a durable op inside a ctx.run action is forbidden, and the measured delta is
  // serialized, so a replay reuses it instead of re-reading a clock.
  const started = options.ctx.localDate?.now() ?? Date.now();
  const elapsed = (): number => Math.max(0, (options.ctx.localDate?.now() ?? Date.now()) - started);
  try {
    const turn = await callProvider(options, onStats, onDelta);
    return { outcome: { kind: 'turn', turn }, durationMs: elapsed() };
  } catch (error) {
    // A failed attempt still serializes how long it ran, so its active time can be charged truthfully.
    if (error instanceof ProviderFailureError) return { outcome: { kind: 'provider_failure', failure: error.failure }, durationMs: elapsed() };
    if (error instanceof ModelTurnError) return { outcome: { kind: 'terminal', code: error.code, message: error.message }, durationMs: elapsed() };
    const terminal = toTerminalModelError(error);
    if (terminal) return { outcome: { kind: 'terminal', code: 'terminal', message: terminal.message }, durationMs: elapsed() };
    throw error;
  }
}

/**
 * Normalize a journaled model step. Builds before the serialized envelope wrote the raw assistant
 * turn under the same first key (`model:N`), and an in-flight run must keep replaying: a value with
 * no `kind` is that older turn, not a crash.
 */
function normalizeOutcome(value: JournaledAttempt | AssistantTurn): JournaledAttempt {
  if ('outcome' in value) return value;
  // A build before the serialized envelope wrote the raw assistant turn under the same first key.
  return { outcome: { kind: 'turn', turn: value }, durationMs: 0 };
}

/**
 * What the person reads when a failure could not be absorbed (`Run.error`, the task row, a push): one plain sentence by kind. The provider's own
 * words and the status code go to the log, with how many calls were made (`calls` counts every provider call).
 */
function terminalReason(options: RecoverModelOptions, failure: ProviderFailure, calls: number, fellBack: boolean): string {
  options.services.log?.({ runId: options.runId, step: options.stepIndex, kind: failure.kind, code: failure.code, calls, fellBack, retryAfterMs: failure.retryAfterMs, error: failure.message }, 'model call failed for good');
  return plainProviderFailure(failure.kind);
}

/**
 * One durable model turn under the bounded recovery policy. Keys stay journal-stable for the first
 * attempt (existing journals replay) and take a retry suffix only where the previous build never
 * journaled anything. Auth and invalid requests are terminal at once. Quota and transient failures
 * retry on the primary with exponential backoff (a durable sleep, honouring a short retry-after),
 * then move once to the snapshot's fallback model when it names one, and only then fail. A context
 * overflow gets exactly one compaction — whose RETURNED context is what the retry uses — before it
 * becomes terminal.
 */
export async function recoverModelTurn(options: RecoverModelOptions): Promise<RecoveredModelStep | typeof CANCELLED> {
  const { ctx, services, runId, stepIndex, recovery } = options;
  let brainCtx = options.brainCtx;
  for (let attempt = 0; ; attempt += 1) {
    const key = recovery.fellBack === true
      ? `model:${stepIndex}:fallback:${attempt}`
      : attempt === 0 ? `model:${stepIndex}` : `model:${stepIndex}:retry:${attempt}`;
    const raced = await options.cancellation.race(() => options.ctx.run<JournaledAttempt | AssistantTurn>(key, async (): Promise<JournaledAttempt> => serializeAttempt({ ...options, brainCtx }, key)));
    if (raced === CANCELLED) return CANCELLED;
    const journaled = normalizeOutcome(raced);
    // Charged outside the durable action, once per attempt key, so a replay adds nothing.
    if (options.onAttempt !== undefined) await options.onAttempt(key, journaled.outcome, journaled.durationMs);
    const outcome = journaled.outcome;
    if (outcome.kind === 'turn') return { turn: outcome.turn, brainCtx, durationMs: journaled.durationMs, key };
    if (outcome.kind === 'terminal') {
      // A terminal attempt still burned real active time: charge its journaled duration before
      // reporting, exactly like a failed provider attempt. Spend authority wins over failure
      // reporting (an exhausted budget blocks), otherwise the honest terminal error propagates
      // and the turn never retries or returns a turn as success.
      const terminalWithin = await chargeFailedAttemptStep({ ctx, services, runId, budget: options.budget, key, durationMs: journaled.durationMs });
      if (!terminalWithin.ok) throw BUDGET_EXHAUSTED;
      throw new TerminalError(outcome.message, { metadata: { code: outcome.code } });
    }
    const failedWithin = await chargeFailedAttemptStep({ ctx, services, runId, budget: options.budget, key, durationMs: journaled.durationMs });
    if (!failedWithin.ok) throw BUDGET_EXHAUSTED;
    const failure = outcome.failure;
    if (failure.kind === 'context_overflow' && !recovery.compacted) {
      recovery.compacted = true;
      // A compaction a few steps ago did not make the history fit: another one would not either.
      if (recentlyCompacted(options.compactions, stepIndex)) throw COMPACTION_THRASH;
      // The compacted context is the point of the retry; keeping the old one would overflow again.
      const overflowed = brainCtx;
      brainCtx = await ctx.run(`compact:${stepIndex}:recovery`, () => compactAndRefresh(services, options.input, overflowed, options.tools, `ctxN:${runId}:${stepIndex}:overflow`));
      if (brainCtx.compactionEpoch !== overflowed.compactionEpoch) options.compactions.steps.push(stepIndex);
      const compactWithin = await chargeCompactionStep({ ctx, services, runId, budget: options.budget, key: 'compact:' + String(stepIndex) + ':recovery', context: brainCtx });
      if (!compactWithin.ok) throw BUDGET_EXHAUSTED;
      continue;
    }
    const retryable = failure.kind === 'transient' || failure.kind === 'quota';
    if (retryable) {
      const delayMs = retryDelayMs(recovery.transient, failure.retryAfterMs, `${runId}:${String(stepIndex)}:${String(attempt)}`);
      if (delayMs !== undefined && recovery.transient < MAX_TRANSIENT_ATTEMPTS) {
        if (!(await backoff(options, delayMs))) return CANCELLED;
        recovery.transient += 1;
        continue;
      }
      // The primary's retries are spent: one attempt on the fallback model, when the snapshot names one.
      const fallback = recovery.fellBack === true ? undefined : withFallbackModel(brainCtx);
      if (fallback !== undefined) {
        recovery.fellBack = true;
        brainCtx = fallback;
        continue;
      }
    }
    const calls = recovery.transient + 1 + (recovery.fellBack === true ? 1 : 0);
    // The provider's announced wait rides along (milliseconds): a run nobody waits on is tried again after it (routine-refire.ts).
    throw new TerminalError(terminalReason(options, failure, calls, recovery.fellBack === true), { metadata: { code: failure.code, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: String(failure.retryAfterMs) }) } });
  }
}

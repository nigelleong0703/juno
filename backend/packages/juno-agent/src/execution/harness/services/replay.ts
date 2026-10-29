import { z } from 'zod';
import type { RestatePromise } from '@agent-desktop/durable';
import type { Doc, Store, ToolReconciliation, ToolResult } from '../../../contracts/index.js';
import { CANCELLED, NEVER_CANCELLED, type RunCancellation } from './cancel.js';
import { redactText } from './redaction.js';

/**
 * The slice of Restate's WorkflowContext the tool loop needs. Keeping it narrow makes the fence
 * logic unit-testable without the SDK; a real WorkflowContext is structurally assignable.
 */
export interface ToolRunContext {
  rand: { uuidv4(): string };
  run<T>(name: string, action: () => Promise<T>): RestatePromise<T>;
}

/**
 * Private, typed execution metadata stored on a step doc (no frontend contract change). `fencedAt`
 * is written before a `replay:"never"` action starts; `result` caches that action's outcome so a
 * recovered run can reuse it instead of re-executing. Read back through zod, never through a cast.
 */
const executionEnvelopeSchema = z.object({
  execution: z
    .object({
      fencedAt: z.string().optional(),
      legacyBinding: z.boolean().optional(),
      intent: z.object({
        ownerId: z.string().min(1), agentId: z.string().min(1), tool: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        conversationId: z.string().optional(), connectionId: z.string().optional(), account: z.string().optional(), attempt: z.number().int().positive().optional(),
      }).optional(),
      reconciliation: z.object({
        status: z.enum(['succeeded', 'not_executed', 'unknown', 'failed']),
        evidence: z.string().max(500).optional(),
        reason: z.string().max(500).optional(),
        checkedAt: z.string(),
      }).optional(),
      result: z
        .object({
          content: z.array(
            z.union([
              z.object({ type: z.literal('text'), text: z.string() }),
              z.object({ type: z.literal('image'), mimeType: z.string(), data: z.string() }),
            ]),
          ),
          details: z.record(z.string(), z.unknown()).optional(),
          isError: z.boolean().optional(),
          suspend: z
            .object({
              reason: z.enum(['user', 'time', 'event', 'child']),
              awakeableId: z.string().optional(),
              until: z.string().optional(),
            })
            .optional(),
          /** Trusted active effect time; absent on rows cached before duration was journaled. */
          runtimeActiveMs: z.number().finite().min(0).optional(),
        })
        .optional(),
    })
    .optional(),
});

type StepExecution = NonNullable<z.infer<typeof executionEnvelopeSchema>['execution']>;

export function readExecution(step: unknown): StepExecution | undefined {
  const parsed = executionEnvelopeSchema.safeParse(step);
  return parsed.success ? parsed.data.execution : undefined;
}

async function writeExecution(store: Store, step: Doc<'steps'>, execution: StepExecution): Promise<void> {
  // Merge onto the CURRENT doc (not the stale snapshot) so a late execution write can never revive a
  // step another terminal path already marked (e.g. a stop that set status: 'failed').
  const current = await store.get('steps', step.id);
  const next: Doc<'steps'> & { execution: StepExecution } = {
    ...(current ?? step),
    execution: { ...readExecution(current), ...execution },
  };
  await store.put('steps', next, { runId: step.runId });
}

/** Bind an encountered historical fence conservatively; unknown historical arguments still require review. */
export async function bindLegacyFence(store: Store, step: Doc<'steps'>, intent: NonNullable<StepExecution['intent']>): Promise<boolean> {
  const execution = readExecution(await store.get('steps', step.id));
  if (!execution?.fencedAt || execution.intent !== undefined || execution.result !== undefined) return execution?.legacyBinding === true;
  await writeExecution(store, step, { ...execution, intent, legacyBinding: true });
  return true;
}

/** Preserve a reconciled/retried outcome on the original call so later replay does not inspect or execute it again. */
export async function cacheFencedResult(store: Store, step: Doc<'steps'>, result: ToolResult): Promise<void> {
  const current = readExecution(await store.get('steps', step.id));
  await writeExecution(store, step, { ...current, result });
}

/** The message the model must see when a fenced action was cut off before it finished. */
export function interruptedReason(name: string): string {
  return (
    `Tool ${name} was interrupted before its result was saved. It may already have taken effect, so it was not run ` +
    'again. Re-observe the world (check the state it would have changed) before deciding the next step.'
  );
}

export function interruptedResult(name: string): ToolResult {
  return { content: [{ type: 'text', text: interruptedReason(name) }], isError: true };
}

export interface FencedToolOutcome {
  result: ToolResult;
  interrupted: boolean;
  /** True when the run was cancelled mid-action; the caller must write nothing more for this step. */
  cancelled?: boolean;
  reconciliation?: ToolReconciliation;
}

/**
 * At-most-once execution for one `replay:"never"` side effect, scoped to a generated step id (not the
 * provider's tool-call id, which it may reuse across turns).
 *
 * The fence is written in its own durable step before the action starts, and the action's result is
 * cached on the same step inside the action's own step (before its journal entry commits). On a
 * recovered invocation the SDK replays the fence without running its body, so `claimed` stays false:
 * a previous invocation already crossed the fence. With a cached result we reuse it; without one the
 * action was cut off mid-call and must not run again, so the model is told to re-observe. This is
 * at-most-once: when the outcome is ambiguous we never re-execute and never claim external delivery.
 */
export async function runFencedTool(
  ctx: ToolRunContext,
  store: Store,
  step: Doc<'steps'>,
  name: string,
  action: () => Promise<ToolResult>,
  cancellation: RunCancellation = NEVER_CANCELLED,
  reconcile?: () => Promise<ToolReconciliation>,
  intent?: NonNullable<StepExecution['intent']>,
): Promise<FencedToolOutcome> {
  let claimed = false;
  let recoveredEvidence: ToolReconciliation | undefined;
  await ctx.run(`step:${step.id}:fence`, async () => {
    // A stop that lands before the fence is durable must not claim the action was started.
    if (cancellation.state.cancelled) return;
    const current = readExecution(await store.get('steps', step.id));
    if (current?.fencedAt) return;
    await writeExecution(store, step, { ...current, fencedAt: new Date().toISOString(), ...(intent === undefined ? {} : { intent }) });
    // The durable action only grants this invocation the claim after it has established a new
    // fence. A persisted fence with no journal result belongs to a previous invocation.
    claimed = true;
  });

  // Race the action's own durable step against the run's cancel signal: a non-cooperative tool may
  // finish late, but the run stops now. `action` re-checks cancellation before caching its result, so
  // a late completion is never written back over the stopped step.
  const raced = await cancellation.race(() => ctx.run<FencedToolOutcome>(`tool:${step.id}`, async () => {
    const current = readExecution(await store.get('steps', step.id));
    if (current?.result) return { result: current.result, interrupted: false };
    if (!claimed) {
      const matchesIntent = intent !== undefined && current?.intent !== undefined
        && current.intent.ownerId === intent.ownerId
        && current.intent.agentId === intent.agentId
        && current.intent.tool === intent.tool
        && current.intent.fingerprint === intent.fingerprint
        && current.intent.conversationId === intent.conversationId
        && current.intent.connectionId === intent.connectionId
        && current.intent.account === intent.account
        && current.intent.attempt === intent.attempt;
      if (current?.legacyBinding === true || reconcile === undefined || !matchesIntent) return { result: interruptedResult(name), interrupted: true };
      if (cancellation.state.cancelled) return { result: interruptedResult(name), interrupted: true, cancelled: true };
      let evidence: ToolReconciliation;
      try {
        evidence = await reconcile();
      } catch (error) {
        evidence = { status: 'failed', reason: redactText(error instanceof Error ? error.message : 'the read-only result check failed').slice(0, 400) };
      }
      if (cancellation.state.cancelled) return { result: interruptedResult(name), interrupted: true, cancelled: true };
      recoveredEvidence = evidence;
      const safeEvidence: ToolReconciliation = evidence.status === 'succeeded'
        ? { ...evidence, evidence: redactText(evidence.evidence).slice(0, 500) }
        : evidence.status === 'not_executed'
          ? { ...evidence, evidence: redactText(evidence.evidence).slice(0, 500) }
          : { ...evidence, reason: redactText(evidence.reason).slice(0, 500) };
      recoveredEvidence = safeEvidence;
      await writeExecution(store, step, {
        ...current,
        reconciliation: {
          status: safeEvidence.status,
          ...('evidence' in safeEvidence ? { evidence: safeEvidence.evidence } : { reason: safeEvidence.reason }),
          checkedAt: new Date().toISOString(),
        },
      });
      if (safeEvidence.status === 'succeeded') {
        await writeExecution(store, step, { ...current, result: safeEvidence.result, reconciliation: { status: 'succeeded', evidence: safeEvidence.evidence, checkedAt: new Date().toISOString() } });
        return { result: safeEvidence.result, interrupted: false, reconciliation: safeEvidence };
      }
      if (safeEvidence.status !== 'not_executed') {
        const message = safeEvidence.status === 'failed'
          ? `The result of ${name} could not be checked (${safeEvidence.reason}). It was not retried; the user must review it.`
          : `The result of ${name} is still unknown (${safeEvidence.reason}). It was not retried; the user must review it.`;
        return { result: { ...interruptedResult(name), content: [{ type: 'text', text: message }] }, interrupted: true, reconciliation: safeEvidence };
      }
      if (current?.intent?.attempt === undefined) {
        return {
          result: { content: [{ type: 'text', text: `A read-only check confirmed that ${name} did not execute. A separate retry fence is required before it can be attempted.` }], isError: true },
          interrupted: true,
          reconciliation: safeEvidence,
        };
      }
      // This is the already fenced, explicitly numbered retry attempt. Re-entering it is allowed
      // only after the adapter positively proves that this attempt did not execute; action still
      // performs the current permission check before any write.
      claimed = true;
    }
    const result = await action();
    // The action may ignore its abort signal. Never cache its result or surface it to the model after
    // a stop: the step is reported interrupted (the effect, if it happened, is not claimed undone).
    if (cancellation.state.cancelled) return { result: interruptedResult(name), interrupted: true, cancelled: true };
    const errorKind = result.details?.['errorKind'];
    if (result.isError === true && (errorKind === 'timeout' || errorKind === 'external' || errorKind === 'harness')) {
      const reason = redactText(result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n') || `The ${name} action returned an ambiguous ${String(errorKind)} error.`).slice(0, 500);
      const evidence: ToolReconciliation = { status: 'unknown', reason };
      await writeExecution(store, step, { ...current, reconciliation: { status: 'unknown', reason, checkedAt: new Date().toISOString() } });
      return { result: { ...interruptedResult(name), content: [{ type: 'text', text: `The result of ${name} is unknown (${reason}); it was not retried and needs review.` }] }, interrupted: true, reconciliation: evidence };
    }
    await writeExecution(store, step, { ...current, result });
    return { result, interrupted: false, ...(recoveredEvidence === undefined ? {} : { reconciliation: recoveredEvidence }) };
  }));
  if (raced === CANCELLED) return { result: interruptedResult(name), interrupted: true, cancelled: true };
  return raced;
}

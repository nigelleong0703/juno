import { toolsForModel } from '../../../modules/tools/tools/toolSearch.js';
import { workflow, JournalMismatchError, RestatePromise, RETRIES_EXHAUSTED_MESSAGE, TerminalError, type WorkflowContext, type WorkflowSharedContext } from '@agent-desktop/durable';
import type { WakeEvent } from '../../../contracts/index.js';
import type { Agent } from '@agent-desktop/public-contracts';
import { appendWakeEvents } from '../../brain/index.js';
import { toTerminalModelError } from '../../brain/model-selection.js';
import { createRunCancellation, type CancelSource } from './cancel.js';
import { routineTimerDef, sessionDef, type RoutineTimerDef, type SessionDef } from './definitions.js';
import { finalizeTerminalRun } from './run-finalize.js';
import type { ReportContext } from './routine-completion.js';
import { attachmentPlacement, type RunContext, type RunInput, type RunServices } from './run-types.js';
import { CONVERSATION_GONE, inOwnerScope, resolveAdmittedOwner } from '../../execution-owner.js';
import { defaultRegistry, startEngineForRun } from './run-engine.js';
import type { RunStartContext } from './run-engine.js';
import type { EngineOutcome } from '../engines/registry.js';
import { notifyBackgroundParent } from './child-notify.js';
import { recordChainCost } from './chain-cost.js';
import { offersQuietExit } from '../logic/run-origin.js';
import { scopeChildTools, scopeToolsFor } from './tool-policy.js';
import { offeredIn, presentToolScope, readToolScope } from '../../../modules/tools/scope.js';
import { sendCompletionWake } from './completion-wake.js';
import { startRunAuxiliaries } from './run-aux.js';
import { prepareToolDisclosure } from './run-disclosure.js';
import { expirePendingRequests } from '../../child-run-input.js';
import { emitAgentStatus } from '../../agent-status.js';
import { runTerminalEvent } from './agui-events.js';
import { closeRunTasks } from '../../../modules/tasks/agent-tasks.js';
import { isTerminal } from '../../../modules/tasks/childRead.js';

export { startEngineForRun, type RunStartContext } from './run-engine.js';

/** Map a typed account-model failure to terminal; anything else keeps the retry path. */
async function guardModelContext<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const terminal = toTerminalModelError(error);
    if (terminal) throw terminal;
    throw error;
  }
}

/**
 * Narrow pinned surface the Run body needs. A real WorkflowContext is structurally assignable through
 * the adapter in `createRunWorkflow`; tests drive the same body with a plain fake, so owner scoping and
 * the reply path get real regression coverage instead of asserting on a re-implementation.
 */
export interface RunBodyContext extends RunContext, ReportContext {
  key: string;
  /** True on the last try the runner allows: a retryable failure then ends the run through the normal failed finalize. */
  lastAttempt?: boolean;
  /** Aborted when this execution's database lease is lost; cooperative work stops instead of racing the new owner. */
  leaseSignal?: AbortSignal;
  cancel: CancelSource;
  runFinished(sessionKey: string, runId: string): Promise<void>;
}

/**
 * One Run: validate the wake's owner, enter that owner's scope and run the durable loop. A refused
 * wake is terminated with no Store write and no Session RPC, so a spoofed or malformed raw invocation
 * can never mutate another owner's data; an accepted run's engine-selection failure still finalizes a
 * failed Run and releases its canonical Session.
 */
export async function runWorkflowBody(ctx: RunBodyContext, services: RunServices, input: RunInput): Promise<void> {
  if (!input.agentId || !input.conversationId || input.wakeEvents.length === 0) {
    throw new Error('Invalid RunInput');
  }

  const runId = ctx.key;
  const cancellation = createRunCancellation(ctx.cancel, ctx.leaseSignal);
  const registry = services.engines ?? defaultRegistry();
  const starter: RunStartContext = {
    runInit: (action) => ctx.run('init', action),
    runFail: (action) => ctx.run('fail-fast', action),
    releaseSession: (sessionKey, failedRunId) => ctx.runFinished(sessionKey, failedRunId),
  };

  // Validate the wake's owner against the stored agent/conversation before any write enters a scope,
  // then run the whole turn inside that owner's scope so every write/event resolves to the owner.
  const admitted = await resolveAdmittedOwner(services.store, input.wakeEvents, input);
  if (admitted.reason === CONVERSATION_GONE) {
    // The conversation was deleted while this run waited in the session inbox. The agent's owner already matched,
    // so release the session (it then starts or drops its next queued batch) and write nothing.
    await ctx.runFinished(input.sessionKey, runId);
    return;
  }
  if (admitted.ownerId === undefined) {
    // Refusal is side-effect free: the owner, target and session key are all untrusted here, so a
    // spoofed or malformed raw invocation must not write a Run, emit an event, or touch a Session.
    throw new TerminalError(`run refused: ${admitted.reason ?? 'missing_owner'}`);
  }

  await inOwnerScope(admitted.ownerId, async () => {
    const agent: Agent | null = await ctx.run('load-agent', async () =>
      services.store.get('agents', input.agentId),
    );
    if (agent === null) {
      // The row is not owner-stamped: writing a Run for it would reproduce the very 'unknown' rows this
      // change removes, so refuse without side effects. `receive` rejects this case before any run starts.
      throw new TerminalError('run refused: agent is not visible to the wake owner');
    }

    // Detached auxiliary work (short title, role suggestion) starts inside the journaled init step (BACKEND §10.11).
    const { adapter } = await startEngineForRun(starter, services.store, registry, agent, input, runId, cancellation, () => startRunAuxiliaries(services, input, runId)).catch(async (error: unknown) => {
      // Only a permanent start failure ends the child; a transient one is retried by Restate and must not
      // report 'failed' (its id would then shadow the real completion as a duplicate).
      if (error instanceof TerminalError) await notifyBackgroundParent(ctx, services.store, runId, 'failed');
      throw error;
    });

    let outcome: EngineOutcome;
    try {
      // The wake that started this run is its first user turn: persist it exactly once (journaled) BEFORE
      // building the context, so every later run reads it back from the transcript in chronological order
      // and the current wake is never injected a second time.
      await ctx.run('persist-wake', async () => {
        await appendWakeEvents(services.store, services.blobs, input.sessionKey, input.wakeEvents, attachmentPlacement(services, input), services.brain, offersQuietExit(await services.store.get('runs', runId)));
      });

      // Optional first-model tool preparation, once per run: journaled, raced with the
      // stop signal, and appended as a labelled user note before the first brain context.
      const disclosure = await prepareToolDisclosure(ctx, services, input, runId, cancellation);
      if (disclosure === 'stopped') {
        await finalizeTerminalRun(ctx, services, input, runId, { kind: 'stopped' });
        await ctx.run('chain-cost', () => recordChainCost(services.store, input, runId));
        await notifyBackgroundParent(ctx, services.store, runId, 'stopped');
        await ctx.runFinished(input.sessionKey, runId);
        return;
      }

      const brainCtx = await ctx.run('load-context', async () =>
        // An invalid account selection (or endpoint drift on resume) is permanent: convert it
        // to terminal here so the run finalizes as failed and releases the Session instead
        // of retrying a load-context that will never succeed.
        await guardModelContext(async () => {
          const built = await services.brain.buildContext({
            agentId: input.agentId,
            conversationId: input.conversationId,
            sessionKey: input.sessionKey,
            wake: input.wakeEvents,
            // Deterministic note row id for this run's first note, and the tools whose order the session persists.
            noteKey: `ctx0:${runId}`,
            toolNames: await discoveredToolNames(services, input),
          });
          // Journal the reference, not the message list: a model call re-derives it from the transcript.
          return services.brain.slim?.(built) ?? built;
        }),
      );

      // The harness version the session is pinned to, recorded on the run so results can be counted per version.
      const harnessVersion = brainCtx['harnessVersion'];
      if (typeof harnessVersion === 'string') await ctx.run('harness-version', () => services.store.patch('runs', runId, { harnessVersion }));

      // The conversation's frozen tool scope (batch 5b) narrows the tools this run is offered and may call.
      const toolScope = readToolScope(brainCtx['toolScope']);
      const scoped = scopeToolsFor(await scopeChildTools(ctx, services, input), toolScope);
      // The scope rides on the input too (set during the run, like supportsImages), so each tool's context reads the same one.
      if (toolScope !== undefined) input.toolScope = toolScope;
      outcome = await adapter.executeTurn({ ctx, services: scoped, input, runId, brainCtx, cancellation });
    } catch (error) {
      // The replay of a taken-over run met a Stop that arrived after the journal was written: the cancel signal is read live, so
      // an earlier checkpoint saw it than the original execution did, and the code took the stop path where the journal has
      // something else. The person asked for a stop: end it as stopped, outside the journal (BACKEND 2.2c "Stop during a replay").
      if (error instanceof JournalMismatchError && (await cancellation.peek())) {
        await stopDivergedRun(services, input, runId);
        return;
      }
      // A transient failure is retried by Restate: rethrow without finalizing so the Session keeps its
      // activeRunId. Only a permanent (terminal) failure finalizes the run and releases the Session.
      if (!(error instanceof TerminalError) && ctx.lastAttempt !== true) throw error;
      // The terminal message is already safe to surface: engine-selection and refusal messages are
      // fixed strings, and model-timeout/budget messages are secret-scrubbed by the provider before
      // they become terminal. Persist it on the run so the failure reason stays visible in the UI.
      const message = error instanceof TerminalError ? error.message : RETRIES_EXHAUSTED_MESSAGE;
      await finalizeTerminalRun(ctx, services, input, runId, { kind: 'failed', message });
      await ctx.run('chain-cost', () => recordChainCost(services.store, input, runId));
      await notifyBackgroundParent(ctx, services.store, runId, 'failed');
      await ctx.runFinished(input.sessionKey, runId);
      throw error instanceof TerminalError ? error : new TerminalError(message);
    }

    if (outcome === 'stopped') {
      await finalizeTerminalRun(ctx, services, input, runId, { kind: 'stopped' });
    } else if (outcome === 'blocked') {
      await finalizeTerminalRun(ctx, services, input, runId, { kind: 'blocked' });
    } else {
      await finalizeTerminalRun(ctx, services, input, runId, { kind: 'completed' });
    }
    await ctx.run('chain-cost', () => recordChainCost(services.store, input, runId)); // H-75
    // H-69: a background child reports its end to the session that spawned it (exactly once).
    await notifyBackgroundParent(ctx, services.store, runId, outcome === 'stopped' || outcome === 'blocked' ? outcome : 'completed');

    await ctx.runFinished(input.sessionKey, runId);
  });
}

export const createRunWorkflow = (services: RunServices) => {
  const run = (ctx: WorkflowContext, input: RunInput): Promise<void> =>
    runWorkflowBody(
      {
        key: ctx.key,
        lastAttempt: ctx.lastAttempt,
        leaseSignal: ctx.leaseSignal,
        rand: ctx.rand,
        // Durable time source: step durations are measured inside their own journaled action.
        // The SDK clock is durable and top-level; the lift only reconciles its nominal type.
        date: { now: () => RestatePromise.resolve(ctx.date.now()) },
        sleep: (ms) => ctx.sleep(ms),
        run: <T>(name: string, action: () => Promise<T>): RestatePromise<T> => ctx.run(name, action),
        awakeable: <T>() => ctx.awakeable<T>(),
        drainInbox: (): RestatePromise<WakeEvent[]> =>
          ctx.objectClient<SessionDef>(sessionDef, input.sessionKey).drainInbox(),
        typingState: () => ctx.objectClient<SessionDef>(sessionDef, input.sessionKey).typingState(),
        cancel: ctx.promise<boolean>('cancel'),
        runFinished: (sessionKey, failedRunId) =>
          ctx.objectClient<SessionDef>(sessionDef, sessionKey).runFinished(failedRunId),
        completeRoutine: (params) => ctx.objectClient<RoutineTimerDef>(routineTimerDef, params.routineId).recordCompletion(params),
        sendWake: (wake, delayMs) => sendCompletionWake(ctx, wake, delayMs),
      },
      services,
      input,
    );

  const cancel = async (ctx: WorkflowSharedContext): Promise<void> => {
    await ctx.promise<boolean>('cancel').resolve(true);
  };

  return workflow({
    name: 'Run',
    handlers: { run, cancel },
    onFailure: ({ key, input, message }) => failAbandonedRun(services, key, input, message),
  });
};

function isRunInput(value: unknown): value is RunInput {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'agentId') === 'string'
    && typeof Reflect.get(value, 'conversationId') === 'string' && typeof Reflect.get(value, 'sessionKey') === 'string'
    && Array.isArray(Reflect.get(value, 'wakeEvents'));
}

/**
 * The normal stop finalize, but not journaled: the journal no longer lines up with the code, so a journaled step (or a Session call,
 * which is one) would mismatch again. Every action is idempotent (the stop skips a run that is already stopped; the chain cost counts
 * a run once; the session ignores a release for a run that is not its active one).
 */
async function stopDivergedRun(services: RunServices, input: RunInput, runId: string): Promise<void> {
  const unjournaled: ReportContext = { run: <T>(_name: string, action: () => Promise<T>): RestatePromise<T> => RestatePromise.resolve(action()) };
  await finalizeTerminalRun(unjournaled, services, input, runId, { kind: 'stopped' });
  await recordChainCost(services.store, input, runId);
  await services.enqueuer.releaseSession?.(input.sessionKey, runId);
}

/**
 * Safety net for a Run that ended in terminal failure without finalizing itself (a saved-step mismatch, a failure
 * before the run row existed): mark the row failed with the reason and free the chat. A run that already
 * finalized is left alone, and the session ignores a release for a run that is not its active one.
 */
async function failAbandonedRun(services: RunServices, runId: string, input: unknown, message: string): Promise<void> {
  if (!isRunInput(input)) return;
  const admitted = await resolveAdmittedOwner(services.store, input.wakeEvents, input);
  if (admitted.ownerId === undefined) return;
  await inOwnerScope(admitted.ownerId, async () => {
    const run = await services.store.get('runs', runId);
    if (run !== null && !isTerminal(run.status)) {
      await expirePendingRequests(services.store, runId);
      const failed = await services.store.patch('runs', runId, { status: 'failed', finishedAt: new Date().toISOString(), error: message });
      await services.store.emit(runTerminalEvent(failed));
      await closeRunTasks(services.store, failed);
      await emitAgentStatus(services.store, failed.agentId);
    }
    await services.enqueuer.releaseSession?.(input.sessionKey, runId);
  });
}

/** The names of the agent's tools now; undefined when discovery fails (the persisted order is then kept as is). */
async function discoveredToolNames(services: RunServices, input: RunInput): Promise<string[] | undefined> {
  try {
    // Only the names this run may use, in the scope of who is present now (batch 5b): the persisted order names no hidden tool.
    const scope = await presentToolScope(services.store, { ownerId: input.wakeEvents[0]?.ownerId, agentId: input.agentId, conversationId: input.conversationId, wake: input.wakeEvents });
    return toolsForModel(offeredIn(scope, await services.toolRegistry.forAgent(input.agentId))).map((tool) => tool.name);
  } catch {
    return undefined;
  }
}

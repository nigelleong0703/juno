/**
 * The runtime todo gate for one run loop.
 *
 * Owns every journaled read of the authoritative bound plan, the trusted internal hints and the
 * no-progress counters, so the loop body stays thin orchestration. Reads and writes happen inside
 * named durable steps because the plan is shared mutable state. A child scope never falls back to
 * root: absence means own none, malformed blocks fail-closed.
 */
import { appendToTranscript } from '../../brain/index.js';
import {
  MAX_UNCHANGED_FINALS,
  MAX_VERIFICATION_ATTEMPTS,
  blockedInputHint,
  blockedReason,
  blockedTodos,
  checksToVerify,
  continueHint,
  openTodos,
  planSignature,
  readRunTasks,
  reconcileHint,
  setTodoEvidence,
  setTodoOutcome,
  taskHintMessage,
  verificationBlockedReason,
  verificationHint,
  type BlockCause,
  type RunTaskState,
} from './task-hooks.js';
import type { RunCancellation } from './cancel.js';
import { activeChildren, childBlockedReason, childContinueHint, childSignature } from './child-completion.js';
import { markRunBlocked, runBlockCause } from './run-block.js';
import { runTodoChecks } from './verification.js';
import type { RunBudget } from './run-budget.js';
import { isChildPlan } from '../../../modules/tasks/state.js';
import type { WakeKind } from '../../../contracts/index.js';
import type { ChildStatus } from '../../../modules/tasks/child.js';
import type { RunContext, RunInput, RunServices } from './run-types.js';

/** Wakes that can carry what a task blocked on input was waiting for. */
const ANSWER_WAKES: ReadonlySet<WakeKind> = new Set<WakeKind>(['user_message', 'room_mention', 'request_resolved', 'hand_back', 'task_done']);

export type SettleDecision = 'completed' | 'blocked' | 'continued';

export interface TodoGate {
  settleFinal(key: string): Promise<SettleDecision>;
  /** Append an internal hint to the transcript (durable); the loop's next model step sees it. */
  hint(key: string, text: string): Promise<void>;
  reconcile(key: string): Promise<void>;
  /** At run start: tell the model tasks blocked on input may have just been answered. */
  announceBlocked(key: string): Promise<void>;
  noteToolTurn(): void;
  afterStepLimit(): Promise<'completed' | 'blocked'>;
}

export function createTodoGate(ctx: RunContext, services: RunServices, input: RunInput, runId: string, cancellation?: RunCancellation, budget?: RunBudget): TodoGate {
  let lastPlanSignature: string | null = null;
  let finalsSinceProgress = 0;
  let toolTurnsSinceFinal = 0;
  let verificationAttempts = 0;
  let lastChildSignature: string | null = null;
  let childFinalsSinceProgress = 0;

  const taskState = (key: string): Promise<RunTaskState> =>
    ctx.run('tasks:' + key, () => readRunTasks(services.store, input.agentId, input.conversationId, runId));

  const appendHint = async (key: string, hint: string): Promise<void> => {
    if (hint.length === 0) return;
    const rowKey = ctx.rand.uuidv4();
    await ctx.run('todo-hint:' + key, async () => {
      await appendToTranscript(services.store, input.sessionKey, [taskHintMessage(hint)], rowKey);
    });
  };

  /** CT-boundary: hold the run over live children; the same set without tool work stalls to a block. */
  const settleWithChildren = async (key: string, active: ChildStatus[]): Promise<SettleDecision> => {
    const signature = childSignature(active);
    const progressed = signature !== lastChildSignature || toolTurnsSinceFinal > 0;
    childFinalsSinceProgress = progressed ? 0 : childFinalsSinceProgress + 1;
    lastChildSignature = signature;
    toolTurnsSinceFinal = 0;
    if (childFinalsSinceProgress >= MAX_UNCHANGED_FINALS) {
      await ctx.run('child-block:' + key, async () => {
        await markRunBlocked(services.store, runId, 'no_progress', childBlockedReason(active, false));
      });
      return 'blocked';
    }
    await appendHint(key, childContinueHint(active));
    return 'continued';
  };

  const journalBlock = async (key: string, cause: BlockCause): Promise<void> => {
    await ctx.run('todo-block:' + key, async () => {
      const reason = blockedReason(await readRunTasks(services.store, input.agentId, input.conversationId, runId), cause);
      await markRunBlocked(services.store, runId, runBlockCause(cause), reason);
    });
  };

  const settleFinal = async (key: string): Promise<SettleDecision> => {
    const state = await taskState('settle:' + key);
    if (state.kind === 'unreadable') {
      await journalBlock('settle:' + key, 'unreadable');
      return 'blocked';
    }
    // CT-boundary: a parent may not finish while a child it spawned is still live, even when its
    // own plan is done or absent; the hold carries a child-tools hint instead of a public final.
    const live = await ctx.run('child-read:settle:' + key, () => activeChildren(services.store, runId));
    if (live.length > 0) return settleWithChildren('settle:' + key, live);
    if (state.kind === 'none') return 'completed';
    if (openTodos(state).length === 0) {
      // A child has no user to answer, so its blocked tasks end it blocked and report up. In the user's
      // chat, tasks left `blocked` wait for the user's answer: the reply that asks or answers is a normal
      // end of the run, and they stay blocked in the plan so the next user message continues them.
      if (blockedTodos(state).length > 0 && isChildPlan(state.plan)) {
        await journalBlock('settle:' + key, 'waiting');
        return 'blocked';
      }
      if (blockedTodos(state).length > 0) return 'completed';
      return verifyCompletion('settle:' + key, state, false);
    }
    const signature = planSignature(state);
    const progressed = signature !== lastPlanSignature || toolTurnsSinceFinal > 0;
    finalsSinceProgress = progressed ? 0 : finalsSinceProgress + 1;
    lastPlanSignature = signature;
    toolTurnsSinceFinal = 0;
    if (finalsSinceProgress >= MAX_UNCHANGED_FINALS) {
      await journalBlock('settle:' + key, 'stalled');
      return 'blocked';
    }
    await appendHint('settle:' + key, continueHint(state));
    return 'continued';
  };

  const verifyCompletion = async (key: string, state: Extract<RunTaskState, { kind: 'plan' }>, forceFinal: boolean): Promise<SettleDecision> => {
    const groups = checksToVerify(state.plan);
    if (groups.length === 0) return 'completed';
    const result = await runTodoChecks(ctx, services, input, runId, groups, key, cancellation, budget);
    if (result.budgetSpent) return 'blocked';
    if (cancellation !== undefined && (await cancellation.peek()) === true) return 'blocked';
    if (result.passed) {
      await ctx.run('todo-evidence:' + key, async () => {
        const evidence = { at: new Date().toISOString(), passed: true, summary: result.note };
        for (const group of groups) {
          await setTodoEvidence(services.store, input.agentId, input.conversationId, group.todoId, evidence, undefined, runId);
        }
      });
      return 'completed';
    }
    verificationAttempts += 1;
    const failedTodoIds = [...new Set(result.outcomes.filter((entry) => !entry.passed).map((entry) => entry.todoId))];
    const final = forceFinal || verificationAttempts >= MAX_VERIFICATION_ATTEMPTS;
    const evidence = { at: new Date().toISOString(), passed: false, summary: result.note };
    await ctx.run('todo-verify:' + key, async () => {
      for (const todoId of failedTodoIds) {
        if (final) {
          await setTodoOutcome(services.store, input.agentId, input.conversationId, todoId, 'blocked', result.note, evidence, undefined, runId);
          continue;
        }
        await setTodoOutcome(services.store, input.agentId, input.conversationId, todoId, 'pending', result.note, evidence, undefined, runId);
      }
      if (final) await markRunBlocked(services.store, runId, 'verification', verificationBlockedReason(result.note));
    });
    if (final) return 'blocked';
    await appendHint(key, verificationHint(state, failedTodoIds, result.note));
    return 'continued';
  };

  const reconcile = async (key: string): Promise<void> => {
    const state = await taskState('steer:' + key);
    if (state.kind !== 'plan') return;
    await appendHint('steer:' + key, reconcileHint(state));
  };

  const announceBlocked = async (key: string): Promise<void> => {
    if (!input.wakeEvents.some((wake) => ANSWER_WAKES.has(wake.kind))) return;
    const state = await taskState('announce:' + key);
    if (state.kind !== 'plan' || isChildPlan(state.plan)) return;
    await appendHint('announce:' + key, blockedInputHint(state));
  };

  const afterStepLimit = async (): Promise<'completed' | 'blocked'> => {
    const state = await taskState('limit');
    if (state.kind === 'unreadable') {
      await journalBlock('limit', 'unreadable');
      return 'blocked';
    }
    // CT-boundary: the step limit is truthful about live children even without a plan.
    const live = await ctx.run('child-read:limit', () => activeChildren(services.store, runId));
    if (live.length > 0) {
      await ctx.run('child-block:limit', async () => {
        await markRunBlocked(services.store, runId, 'limit', childBlockedReason(live, true));
      });
      return 'blocked';
    }
    const outstanding = openTodos(state).length + blockedTodos(state).length;
    if (state.kind === 'plan' && outstanding > 0) {
      await journalBlock('limit', 'limit');
      return 'blocked';
    }
    if (state.kind !== 'plan') return 'completed';
    return (await verifyCompletion('limit', state, true)) === 'completed' ? 'completed' : 'blocked';
  };

  return {
    settleFinal,
    hint: appendHint,
    reconcile,
    announceBlocked,
    noteToolTurn: () => {
      toolTurnsSinceFinal += 1;
    },
    afterStepLimit,
  };
}

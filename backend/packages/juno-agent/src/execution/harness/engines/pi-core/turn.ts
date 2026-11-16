/** pi-agent-core inner-turn driver: one inner turn per outer step; the runner stays the only journal. */
import { type AssistantTurn, type ToolResult } from '../../../../contracts/index.js';
import { runAgentLoop } from '@earendil-works/pi-agent-core';
import { validateToolArguments, type ToolCall as PiToolCall } from '@earendil-works/pi-ai';
import type {
  AgentEvent,
  AgentLoopConfig,
  AgentToolResult,
  BeforeToolCallResult,
  FinishTurn,
  PrepareRequest,
  StreamFn,
} from '@earendil-works/pi-agent-core';
import { profileAudience } from '../../../../modules/profile/index.js';
import { readTranscript } from '../../../brain/transcript.js';
import { parseModelSnapshot } from '../../../brain/model-selection.js';
import { orderTools } from '../../../brain/tool-order.js';
import { withoutJunoSearch } from '../../../brain/native-web-search.js';
import { recordNativeSearches } from '../../services/native-search-steps.js';
import { CANCELLED } from '../../services/cancel.js';
import { readSubagentChatRole } from '../../services/subagent-chat-role';
import { unwrapProxyCalls } from '../../../brain/tool-proxy.js';
import { ackStep, asksQuestion, isVoiceRun, citationsOf, emptyFinalStep, expectsReply, givesNothing, recordStep, replyStep } from '../../services/final-reply.js';
import { drainAndAppend } from '../../services/run-input.js';
import { holdWhileTyping } from '../../services/typing-hold.js';
import { executeParallelToolCalls, executeSingleToolCall, supportsParallel } from '../../services/run-tools.js';
import { budgetSpentAfterTools, chargeModelStep, chargeToolCall, checkBeforeTool, toolStepsLeft, type BudgetScope } from '../../services/model-budget.js';
import { handleCoreEvent, journalAssistantTurn } from './journal.js';
import { coreModel, toolCallsOf, turnStream } from './messages.js';
import { lengthDecision } from './length.js';
import { handleSuspension } from './suspend.js';
import { BUDGET_EXHAUSTED, COMPACTION_THRASH, prepareTurnContext, recoverModelTurn, type RecoveryBudget } from './recovery.js';
import { markRunBlocked } from '../../services/run-block.js';
import { CONVERSATION_TOO_LONG } from '../../logic/plain-errors.js';
import { discoverTools, isRecord, toAgentTools, toolIndexOf, type CoreToolCall } from './tools.js';
import type { CoreTurnDeps, CoreTurnResult, TurnState } from './types.js';

const CORE_CANCELLED = new Error('pi-core: turn cancelled');
/** Sentinel: the run's observed spend exhausted its frozen budget before any tool ran. */
const CORE_BLOCKED = new Error('pi-core: budget exhausted');

/**
 * One inner turn, run on the session's pinned harness version (BACKEND §11.2): the tool text the model is shown, the tool_search
 * results and every harness text read during the turn come from the version the session's frozen system row names.
 */
export async function runCoreTurn(deps: CoreTurnDeps): Promise<CoreTurnResult> {
  const { services, input } = deps;
  if (services.brain.withSessionHarness === undefined) return runCoreTurnOnVersion(deps);
  return services.brain.withSessionHarness(await readTranscript(services.store, input.sessionKey), () => runCoreTurnOnVersion(deps));
}

async function runCoreTurnOnVersion(deps: CoreTurnDeps): Promise<CoreTurnResult> {
  const { ctx, services, input, runId, stepIndex, cancellation, deliveredTexts, citations, progress, gate, cardRetry, promiseRetry, noReply } = deps;
  const state: TurnState = { stopped: false, journaled: false, steeredInFlight: false, persisted: new Set() };
  let brainCtx = deps.brainCtx;
  let lastTurn: AssistantTurn | null = null;
  let settled: CoreTurnResult['outcome'] | null = null;
  let lengthStop = false; let callIndex = 0;
  /** The suspension of the batch, with the tool's details: the wait reads runIds/timeout from them. */
  let batchSuspend: { suspend: NonNullable<ToolResult['suspend']>; details: ToolResult['details'] } | null = null;
  const recovery: RecoveryBudget = { transient: 0, compacted: false };
  let batchBlocked = false;
  /** A call of this model turn succeeded with `endsTurn`: after the tools the run finishes with no further model call. */
  let endsTurn = false;
  const goalMode = deps.goalBrowserMode ?? false;
  // Owner-only tools (person_link) are offered only when the owner is alone with the agent in this run.
  const audience = await profileAudience(services.store, { agentId: input.agentId, conversationId: input.conversationId, wake: input.wakeEvents });
  // One model step is one turn: an MCP connection re-lists at most once within it (see McpRefreshOptions).
  const discovered = await discoverTools(services.toolRegistry, input.agentId, cancellation.signal, { goalMode, reactions: deps.reactions === true, roomTalk: deps.roomTalk === true, recent: deps.recentTools ?? [], ownerOnly: audience.ownerOnly, turn: runId + ':' + String(stepIndex) });
  if (discovered === null) return { outcome: 'stopped', brainCtx };
  // Stable order: the session's persisted order first, tools added since appended (see brain/tool-order.ts).
  // The run's frozen snapshot decides once whether the provider's own search replaces Juno's, so the list never changes mid-run.
  const tools = withoutJunoSearch(
    orderTools(discovered, Array.isArray(brainCtx.toolOrder) ? brainCtx.toolOrder.filter((name): name is string => typeof name === 'string') : undefined),
    parseModelSnapshot(brainCtx)?.nativeWebSearch === true,
  );
  // CT-boundary: the child role is the journaled run row's stored parent link, never model text.
  const subagentRun = await readSubagentChatRole(ctx, services, runId, stepIndex);
  // No token preview while the model writes. The user sees the opening line (ackStep), the working state, and the final reply as one bubble.
  const sendOnly = input.sendOnly === true;
  const scope: BudgetScope = { ctx, services, runId, budget: deps.budget };

  const modelTurn = (): AssistantTurn => {
    if (lastTurn === null) throw new Error('pi-core: a turn arrived without an assistant turn');
    return lastTurn;
  };
  const emit = (event: AgentEvent): Promise<void> =>
    handleCoreEvent({ ctx, services, input, stepIndex, cancellation, gate, state, currentTurn: modelTurn }, event);

  const prepareRequest: PrepareRequest = async () => {
    brainCtx = await prepareTurnContext(ctx, services, input, stepIndex, brainCtx, deps.budget, runId, tools, deps.compactions);
  };

  const streamFn: StreamFn = async () => {
    const recovered = await recoverModelTurn({
      ctx, services, input, runId, stepIndex, brainCtx, tools, cancellation, recovery,
      compactions: deps.compactions,
      budget: deps.budget,
    });
    if (recovered === CANCELLED) throw CORE_CANCELLED;
    brainCtx = recovered.brainCtx;
    input.supportsImages = parseModelSnapshot(brainCtx)?.supportsImages !== false;
    input.toolSearch = parseModelSnapshot(brainCtx)?.toolSearch ?? 'proxy';
    input.modelId = parseModelSnapshot(brainCtx)?.modelId;
    const raced = recovered.turn;
    if (raced.stopReason === 'aborted') throw CORE_CANCELLED;
    const within = await chargeModelStep({ ctx, services, runId, stepIndex, budget: deps.budget, usage: raced.usage, key: recovered.key, durationMs: recovered.durationMs, model: parseModelSnapshot(brainCtx)?.modelId });
    if (!within.ok) throw CORE_BLOCKED;
    if (raced.stopReason === 'error') throw new Error('pi-core: the model turn reported an error');
    lastTurn = raced;
    if (raced.webSearches !== undefined) citations.push(...await recordNativeSearches(ctx, services, runId, stepIndex, recovered.key, raced.webSearches, recovered.durationMs ?? 0));
    lengthStop = raced.stopReason === 'length';
    if (raced.toolCalls.length > 0) {
      // Before the tools run, so the opening line shows while the work happens. A question card's lead-in is posted in any turn of the run.
      const asks = asksQuestion(unwrapProxyCalls(raced.toolCalls));
      if (!subagentRun && (asks || !progress.working || isVoiceRun(input))) {
        const ack = await ackStep(ctx, services, input, stepIndex, raced.text, unwrapProxyCalls(raced.toolCalls).map((call) => call.name), cancellation, deliveredTexts, runId, asks);
        if (ack === CANCELLED) throw CORE_CANCELLED;
      }
      progress.working = true;
    }
    return turnStream(raced);
  };

  /** What the model called when a call went through the `tool_call` proxy (kept on the stored tool result). */
  const wireOf = (id: string): { wireName?: string } => {
    const wireName = lastTurn?.toolCalls.find((item) => item.id === id)?.wireName;
    return wireName === undefined ? {} : { wireName };
  };

  /** Results of a parallel run already executed for later calls of the same response (Codex read lock). */
  const ranTogether = new Map<string, Awaited<ReturnType<typeof executeSingleToolCall>>>();

  /** The calls from this one onwards in the response that support parallel execution, stopping at the first that does not. */
  const parallelRun = (call: CoreToolCall): Array<{ id: string; name: string; arguments: Record<string, unknown>; wireName?: string }> => {
    const all = lastTurn?.toolCalls ?? [];
    const at = all.findIndex((item) => item.id === call.id);
    if (at < 0) return [];
    // The current call already passed pi-agent's validation (call.args are the validated arguments).
    const first = { id: call.id, name: call.name, arguments: isRecord(call.args) ? call.args : {}, ...wireOf(call.id) };
    if (!supportsParallel(services, first)) return [];
    const run = [first];
    for (const item of all.slice(at + 1)) {
      const raw = { id: item.id, name: item.name, arguments: item.arguments };
      if (!supportsParallel(services, raw)) break;
      // Same validation pi-agent applies before execute: the run stops at the first invalid call, which
      // then takes the normal path and gets its validation error without any effect.
      const tool = tools.find((entry) => entry.name === raw.name);
      if (tool === undefined) break;
      const [agentTool] = toAgentTools([tool], execute);
      // The arguments came from the model as JSON; a round trip gives pi-ai's JSON type without an assertion.
      const args: PiToolCall['arguments'] = JSON.parse(JSON.stringify(raw.arguments));
      const piCall: PiToolCall = { type: 'toolCall', id: raw.id, name: raw.name, arguments: args };
      let validated: unknown;
      try {
        validated = agentTool === undefined ? undefined : validateToolArguments(agentTool, piCall);
      } catch {
        break;
      }
      run.push({ id: raw.id, name: raw.name, arguments: isRecord(validated) ? validated : {}, ...wireOf(raw.id) });
    }
    return run;
  };

  const execute = async (call: CoreToolCall): Promise<AgentToolResult> => {
    if (state.stopped || state.steeredInFlight) return { content: [], details: undefined, isError: true, terminate: true };
    let outcome = ranTogether.get(call.id);
    if (outcome === undefined) {
      if (!(await checkBeforeTool(scope, stepIndex, call.id)).ok) {
        batchBlocked = true;
        return { content: [], details: undefined, isError: true, terminate: true };
      }
      const run = parallelRun(call);
      if (run.length > 1) {
        // Budget gate for every call of the run up front, in call order; the run stops at the first refused one.
        const allowed = [run[0]!];
        const room = toolStepsLeft(scope);
        for (const next of run.slice(1, Math.max(1, room))) {
          if (!(await checkBeforeTool(scope, stepIndex, next.id)).ok) break;
          allowed.push(next);
        }
        const all = lastTurn?.toolCalls ?? [];
        const outcomes = await executeParallelToolCalls(
          ctx, services, input, runId, stepIndex,
          allowed.map((next, offset) => ({ toolIdx: toolIndexOf(all, next.id, callIndex + offset), call: next })),
          cancellation, deliveredTexts,
        );
        allowed.forEach((next, index) => { const ran = outcomes[index]; if (ran !== undefined) ranTogether.set(next.id, ran); });
        outcome = ranTogether.get(call.id);
      }
    }
    if (outcome === undefined) {
      outcome = await executeSingleToolCall(
        ctx, services, input, runId, stepIndex, toolIndexOf(lastTurn?.toolCalls ?? [], call.id, callIndex),
        { id: call.id, name: call.name, arguments: isRecord(call.args) ? call.args : {}, ...wireOf(call.id) }, cancellation, deliveredTexts,
      );
    }
    callIndex += 1;
    if (outcome === CANCELLED) {
      state.stopped = true;
      return { content: [], details: undefined, isError: true, terminate: true };
    }
    if (!(await chargeToolCall(scope, stepIndex, call.id, outcome.activeMs ?? 0)).ok) batchBlocked = true;
    // The fifth identical failing attempt: the run ends blocked (its reason is already on the run row, run-tools.ts).
    if (outcome.blockRun === true) batchBlocked = true;
    state.persisted.add(call.id);
    if (outcome.result.isError !== true) citations.push(...citationsOf(outcome.result.details));
    if (outcome.result.isError !== true && outcome.result.endsTurn === true) endsTurn = true;
    const suspend = outcome.result.suspend ?? null;
    batchSuspend = suspend === null ? null : { suspend, details: outcome.result.details };
    return {
      content: outcome.result.content,
      details: undefined,
      terminate: true,
      ...(outcome.result.isError === true ? { isError: true } : {}),
    };
  };

  const beforeToolCall = async (): Promise<BeforeToolCallResult | undefined> => {
    if (state.stopped || state.steeredInFlight || batchSuspend !== null || batchBlocked) {
      return { block: true, reason: 'superseded before this call ran', terminate: true };
    }
    return undefined;
  };

  const finishTurn: FinishTurn = async (turn) => {
    if (state.stopped) return { action: 'end' };
    if (toolCallsOf(turn.message).length > 0) {
      if (state.steeredInFlight) return { action: 'end' };
      if (batchSuspend !== null) {
        const suspended = await handleSuspension({ ctx, services, input, runId, stepIndex, suspend: batchSuspend.suspend, details: batchSuspend.details, cancellation });
        if (suspended === 'stopped') state.stopped = true;
      }
      const after = await drainAndAppend(ctx, services, input, cancellation, `tools:${stepIndex}`);
      if (after === CANCELLED) state.stopped = true;
      else if (after) await gate.reconcile(`tools:${stepIndex}`);
      else if (batchBlocked || (await budgetSpentAfterTools(scope, stepIndex))) settled = 'blocked';
      // A tool said "now wait for the person" (a question card): the run is done, with no further model call, no final reply and no
      // empty-final retry. The person's answer starts the next run.
      else if (endsTurn) settled = 'completed';
    } else {
      // The reply is ready: wait for the user to stop typing; a message sent meanwhile is picked up just below. A record line has no reader to wait for.
      const held = await holdWhileTyping(ctx, services, input, stepIndex, cancellation, subagentRun || sendOnly);
      const steered = held === CANCELLED ? CANCELLED : await drainAndAppend(ctx, services, input, cancellation, `model:${stepIndex}`);
      if (steered === CANCELLED) state.stopped = true;
      else if (steered) {
        // A correction supersedes this final turn.
        state.steeredInFlight = true;
        await gate.reconcile(`inflight:${stepIndex}`);
      }
      else if (lengthStop) await journalAssistantTurn(ctx, services, input, stepIndex, modelTurn());
      else {
        const finalTurn = modelTurn();
        await journalAssistantTurn(ctx, services, input, stepIndex, finalTurn);
        // CT-boundary: the hint the gate appends must follow this turn in the transcript, and a
        // held run publishes nothing.
        const settle = await gate.settleFinal(`final:${stepIndex}`);
        if (settle !== 'continued') {
          // A person is waiting and this turn gives them nothing (empty, or the provider declined): one retry with a short note, then the run fails
          // (BACKEND §3.3 "empty or refused final reply"). Anything this run already said to them makes the empty turn fine.
          const nothing = settle === 'completed' && !subagentRun && givesNothing(finalTurn) && expectsReply(input)
            ? await emptyFinalStep(ctx, services, runId, finalTurn, deliveredTexts, noReply)
            : 'unchecked';
          if (typeof nothing === 'object') {
            await gate.hint(`no-reply:${stepIndex}`, nothing.retry);
            settled = 'continued';
          } else if (nothing === 'fine' && finalTurn.stopReason === 'refusal') {
            // Already answered by other means: the provider's refusal text is not a second message.
            settled = settle;
          } else {
            // Only a run that would finish may send the reply back; a blocked one posts what it can.
            // A run that speaks only through send_message keeps its final text as the task's record line and delivers nothing (a child's text is still its result for the parent).
            const posted = sendOnly && !subagentRun
              ? await recordStep(ctx, services, stepIndex, runId, finalTurn.text)
              : await replyStep(ctx, services, input, stepIndex, finalTurn.text, cancellation, deliveredTexts, runId, citations, settle === 'completed' ? cardRetry : undefined, settle === 'completed' ? promiseRetry : undefined);
            if (posted === CANCELLED) state.stopped = true;
            else if (typeof posted === 'object') await gate.hint(`retry:${stepIndex}`, posted.retry);
            else settled = settle;
          }
        }
      }
    }
    if (lengthStop && !state.stopped) settled = await lengthDecision(deps);
    return { action: 'end' };
  };

  const config: AgentLoopConfig = {
    model: coreModel(),
    convertToLlm: (messages) => messages,
    toolExecution: 'sequential',
    prepareRequest,
    beforeToolCall,
    finishTurn,
  };

  try {
    await runAgentLoop([], { messages: [], tools: toAgentTools(tools, (call) => execute(call)) }, config, emit, cancellation.signal, streamFn);
  } catch (error) {
    if (error === CORE_CANCELLED) return { outcome: 'stopped', brainCtx };
    if (error === CORE_BLOCKED || error === BUDGET_EXHAUSTED) return { outcome: 'blocked', brainCtx };
    if (error === COMPACTION_THRASH) {
      // Compacting twice in a few steps did not make the history fit: the run ends here with one plain sentence on the run and its task.
      await ctx.run('thrash-block', () => markRunBlocked(services.store, runId, 'limit', CONVERSATION_TOO_LONG));
      return { outcome: 'blocked', brainCtx };
    }
    throw error;
  }
  if (state.stopped) return { outcome: 'stopped', brainCtx };
  return { outcome: settled ?? 'continued', brainCtx };
}

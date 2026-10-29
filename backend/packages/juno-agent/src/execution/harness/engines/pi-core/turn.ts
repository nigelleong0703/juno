/** pi-agent-core inner-turn driver: one inner turn per outer step; Restate stays the only journal. */
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
import { childSuspendFromDetails, readChildChatRole } from '../../services/child-chat-role.js';
import { ackStep, blockStreaming, citationsOf, discardStreamed, replyStep } from '../../services/final-reply.js';
import { createBlockStreamer, postStreamedBubble, type BlockStreamer } from '../../services/block-stream.js';
import { drainAndAppend } from '../../services/run-input.js';
import { holdWhileTyping } from '../../services/typing-hold.js';
import { executeParallelToolCalls, executeSingleToolCall, supportsParallel } from '../../services/run-tools.js';
import { budgetSpentAfterTools, chargeModelStep, chargeToolCall, checkBeforeTool, toolStepsLeft, type BudgetScope } from '../../services/model-budget.js';
import { QUIET_EXIT_TOOL, QUIET_RESULT_PREFIX, quietReasonOf } from '../../../../modules/tools/tools/finishQuietly.js';
import { handleCoreEvent, journalAssistantTurn } from './journal.js';
import { coreModel, toolCallsOf, turnStream } from './messages.js';
import { lengthDecision } from './length.js';
import { handleSuspension } from './suspend.js';
import { BUDGET_EXHAUSTED, prepareTurnContext, recoverModelTurn, type RecoveryBudget } from './recovery.js';
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
  const { ctx, services, input, runId, stepIndex, cancellation, deliveredTexts, citations, progress, gate, cardRetry, onDelta } = deps;
  const state: TurnState = { stopped: false, journaled: false, steeredInFlight: false, persisted: new Set() };
  let brainCtx = deps.brainCtx;
  let lastTurn: AssistantTurn | null = null;
  let settled: CoreTurnResult['outcome'] | null = null;
  let lengthStop = false; let callIndex = 0;
  /** The suspension of the batch, with the tool's details: the wait reads runIds/timeout from them. */
  let batchSuspend: { suspend: NonNullable<ToolResult['suspend']>; details: ToolResult['details'] } | null = null;
  const recovery: RecoveryBudget = { transient: 0, compacted: false };
  let batchBlocked = false;
  /** The reason of a finish_quietly call in this turn's batch: the run then ends with nothing delivered (BACKEND §3.3a). */
  let quietReason: string | undefined;
  const goalMode = deps.goalBrowserMode ?? false;
  // Owner-only tools (person_link) are offered only when the owner is alone with the agent in this run.
  const audience = await profileAudience(services.store, { agentId: input.agentId, conversationId: input.conversationId, wake: input.wakeEvents });
  // One model step is one turn: an MCP connection re-lists at most once within it (see McpRefreshOptions).
  const discovered = await discoverTools(services.toolRegistry, input.agentId, cancellation.signal, { goalMode, reactions: deps.reactions === true, quietExit: deps.quietExit === true, ownerOnly: audience.ownerOnly, turn: runId + ':' + String(stepIndex) });
  if (discovered === null) return { outcome: 'stopped', brainCtx };
  // Stable order: the session's persisted order first, tools added since appended (see brain/tool-order.ts).
  // The run's frozen snapshot decides once whether the provider's own search replaces Juno's, so the list never changes mid-run.
  const tools = withoutJunoSearch(
    orderTools(discovered, Array.isArray(brainCtx.toolOrder) ? brainCtx.toolOrder.filter((name): name is string => typeof name === 'string') : undefined),
    parseModelSnapshot(brainCtx)?.nativeWebSearch === true,
  );
  // CT-boundary: the child role is the journaled run row's stored parent link, never model text.
  const childRun = await readChildChatRole(ctx, services, runId, stepIndex);
  // No token preview while the model writes. The user sees paragraph bubbles as each closes (block streaming,
  // below), the opening line (ackStep), the working state, and the rest of the final reply.
  // Block streaming: each closed paragraph of a reply that will be shown is posted while the model writes (see block-stream.ts).
  const blocks = !childRun && blockStreaming(input);
  const newBlockStreamer = (): BlockStreamer | undefined => blocks
    ? createBlockStreamer({
        now: () => ctx.localDate?.now() ?? Date.now(),
        wait: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
        post: (index, markdown) => postStreamedBubble(services, input, runId, stepIndex, index, markdown),
        isCancelled: () => cancellation.state.cancelled || cancellation.signal.aborted,
        onError: (error) => services.log?.({ runId, error: error instanceof Error ? error.message : String(error) }, 'block streaming stopped'),
      })
    : undefined;
  let blockStreamer = newBlockStreamer();
  const scope: BudgetScope = { ctx, services, runId, budget: deps.budget };

  const modelTurn = (): AssistantTurn => {
    if (lastTurn === null) throw new Error('pi-core: a turn arrived without an assistant turn');
    return lastTurn;
  };
  const emit = (event: AgentEvent): Promise<void> =>
    handleCoreEvent({ ctx, services, input, stepIndex, cancellation, gate, state, currentTurn: modelTurn }, event);

  const prepareRequest: PrepareRequest = async () => {
    brainCtx = await prepareTurnContext(ctx, services, input, stepIndex, brainCtx, deps.budget, runId, tools);
  };

  const streamFn: StreamFn = async () => {
    const recovered = await recoverModelTurn({
      ctx, services, input, runId, stepIndex, brainCtx, tools, cancellation, recovery,
      budget: deps.budget,
      onDelta: (text) => {
        onDelta?.(text);
        blockStreamer?.push(text);
      },
      afterProvider: async () => { await blockStreamer?.finish(); },
      // A failed attempt starts over with a fresh block streamer, so no partial text is spliced in.
      // Bubbles it streamed stay until the final layout is reconciled; the new attempt overwrites them by id.
      onAttemptStart: async () => {
        blockStreamer = newBlockStreamer();
      },
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
    if (raced.toolCalls.length > 0 && !progress.working) {
      // Before the tools run, so the opening line shows while the work happens.
      if (!childRun) {
        const ack = await ackStep(ctx, services, input, stepIndex, raced.text, raced.toolCalls.map((call) => call.name), cancellation, deliveredTexts, runId);
        if (ack === CANCELLED) throw CORE_CANCELLED;
      }
      progress.working = true;
    } else if (raced.toolCalls.length > 0 && blocks) {
      // Text between later tool calls stays private: anything streamed from it is taken back.
      await discardStreamed(ctx, services, input, stepIndex, runId);
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
    state.persisted.add(call.id);
    if (call.name === QUIET_EXIT_TOOL) quietReason = quietReasonOf(outcome.result);
    if (outcome.result.isError !== true) citations.push(...citationsOf(outcome.result.details));
    const suspend = outcome.result.suspend ?? childSuspendFromDetails(outcome.result.details) ?? null;
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

  /**
   * finish_quietly: the run ends like a completed one, but no reply is posted, whatever text this run wrote (it stays in the steps).
   * The todo gate still decides: with a plan or a helper still open the run goes on (and the reason is dropped). A helper's result is
   * the parent's input, so a child run reports the same line instead of staying silent.
   */
  const finishQuietly = async (reason: string): Promise<CoreTurnResult['outcome']> => {
    const settle = await gate.settleFinal(`quiet:${stepIndex}`);
    if (settle !== 'completed') return settle;
    await ctx.run(`quiet-exit:${stepIndex}`, async () => { await services.store.patch('runs', runId, { quietReason: reason }); return true; });
    if (childRun && await replyStep(ctx, services, input, stepIndex, QUIET_RESULT_PREFIX + reason, cancellation, deliveredTexts, runId) === CANCELLED) state.stopped = true;
    return settle;
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
      else if (quietReason !== undefined) {
        settled = await finishQuietly(quietReason);
        quietReason = undefined;
      }
    } else {
      // The reply is ready: wait for the user to stop typing; a message sent meanwhile is picked up just below.
      const held = await holdWhileTyping(ctx, services, input, stepIndex, cancellation, childRun);
      const steered = held === CANCELLED ? CANCELLED : await drainAndAppend(ctx, services, input, cancellation, `model:${stepIndex}`);
      if (steered === CANCELLED) state.stopped = true;
      else if (steered) {
        // A correction supersedes this final turn: its preview is retracted with the turn.
        state.steeredInFlight = true;
        if (blocks) await discardStreamed(ctx, services, input, stepIndex, runId);
        await gate.reconcile(`inflight:${stepIndex}`);
      }
      else if (lengthStop) await journalAssistantTurn(ctx, services, input, stepIndex, modelTurn());
      else {
        const finalTurn = modelTurn();
        await journalAssistantTurn(ctx, services, input, stepIndex, finalTurn);
        // CT-boundary: the hint the gate appends must follow this turn in the transcript, and a
        // held run publishes nothing.
        const settle = await gate.settleFinal(`final:${stepIndex}`);
        if (settle === 'continued') {
          if (blocks) await discardStreamed(ctx, services, input, stepIndex, runId);
        } else {
          // Only a run that would finish may send the reply back; a blocked one posts what it can.
          const posted = await replyStep(ctx, services, input, stepIndex, finalTurn.text, cancellation, deliveredTexts, runId, citations, settle === 'completed' ? cardRetry : undefined);
          if (posted === CANCELLED) state.stopped = true;
          else if (typeof posted === 'object') await gate.hint(`card-retry:${stepIndex}`, posted.retry);
          else settled = settle;
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
    throw error;
  }
  if (state.stopped) return { outcome: 'stopped', brainCtx };
  return { outcome: settled ?? 'continued', brainCtx };
}

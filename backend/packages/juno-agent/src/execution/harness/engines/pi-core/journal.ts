/**
 * Durable transcript journaling for pi-agent-core events.
 *
 * Core finalizes every tool result itself — including calls it never executed because the name is
 * unknown, the arguments are invalid, a steering correction superseded the batch, or an earlier
 * suspend stopped the batch. Those results otherwise live only in core's in-memory context,
 * which would leave the journaled assistant turn with orphaned tool calls that a later provider
 * request rejects. This module persists the authoritative assistant turn and each finalized result
 * exactly once, each keyed by the stable provider tool-call id. A result the product adapter already
 * wrote (a call it actually executed) is never written twice.
 */
import type { AssistantTurn, ToolResult } from '../../../../contracts/index.js';
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { appendToTranscript, assistantMessage, offloadImages, toolMessage } from '../../../brain/index.js';
import { CANCELLED } from '../../services/cancel.js';
import type { RunCancellation } from '../../services/cancel.js';
import { drainAndAppend } from '../../services/run-input.js';
import type { RunContext, RunInput, RunServices } from '../../services/run-types.js';
import type { TodoGate } from '../../services/todo-gate.js';
import type { TurnState } from './types.js';

/** A finalized core tool result in the product's durable shape. */
export interface FinalizedToolResult {
  toolCallId: string;
  toolName: string;
  result: ToolResult;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The finalized tool result carried by a core message, or null for any other message kind. */
export function finalizedToolResult(message: AgentMessage): FinalizedToolResult | null {
  if (message.role !== 'toolResult') return null;
  return {
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    result: {
      content: message.content,
      isError: message.isError,
      ...(isPlainRecord(message.details) ? { details: message.details } : {}),
    },
  };
}

export async function journalAssistantTurn(
  ctx: RunContext,
  services: RunServices,
  input: RunInput,
  stepIndex: number,
  turn: AssistantTurn,
): Promise<void> {
  const key = ctx.rand.uuidv4();
  await ctx.run(`turn:${stepIndex}`, async () => {
    await appendToTranscript(services.store, input.sessionKey, [assistantMessage(turn)], key);
  });
}

export async function journalToolResult(
  ctx: RunContext,
  services: RunServices,
  input: RunInput,
  stepIndex: number,
  finalized: FinalizedToolResult,
): Promise<void> {
  // The provider may reuse a tool-call id across turns, so the durable step name carries the step.
  const key = ctx.rand.uuidv4();
  await ctx.run(`core-tool-result:${stepIndex}:${finalized.toolCallId}`, async () => {
    await appendToTranscript(services.store, input.sessionKey, [await offloadImages(services.blobs, toolMessage(finalized.toolName, finalized.toolCallId, finalized.result))], key);
  });
}

/** Everything the qualified journal sink needs from one inner-turn driver invocation. */
export interface CoreEventDeps {
  ctx: RunContext;
  services: RunServices;
  input: RunInput;
  stepIndex: number;
  cancellation: RunCancellation;
  gate: TodoGate;
  state: TurnState;
  currentTurn: () => AssistantTurn;
}

/**
 * The qualified journal sink handed to pi-agent-core. On the first `tool_execution_start` it runs
 * the durable steering drain and, unless a correction superseded the turn, persists the assistant
 * turn once before any tool runs. Each finalized tool result message is then persisted once, skipping
 * ids the product adapter already wrote. After a steer or a stop nothing more is written, so a dropped
 * turn leaves no orphan call and no result.
 */
export async function handleCoreEvent(deps: CoreEventDeps, event: AgentEvent): Promise<void> {
  const { ctx, services, input, stepIndex, cancellation, state } = deps;
  if (event.type === 'message_end') {
    if (state.stopped || state.steeredInFlight) return;
    const finalized = finalizedToolResult(event.message);
    if (finalized === null || state.persisted.has(finalized.toolCallId)) return;
    // A call that went through the tool_call proxy is stored under the name the model called.
    const wireName = deps.currentTurn().toolCalls.find((call) => call.id === finalized.toolCallId)?.wireName;
    await journalToolResult(ctx, services, input, stepIndex, wireName === undefined ? finalized : { ...finalized, toolName: wireName });
    // Idempotent within the turn: a repeated end event must not re-run the durable step.
    state.persisted.add(finalized.toolCallId);
    return;
  }
  if (event.type !== 'tool_execution_start' || state.journaled || state.stopped) return;
  const drained = await drainAndAppend(ctx, services, input, cancellation, `model:${stepIndex}`);
  if (drained === CANCELLED) {
    state.stopped = true;
    return;
  }
  if (drained) {
    state.steeredInFlight = true;
    await deps.gate.reconcile(`inflight:${stepIndex}`);
    return;
  }
  await journalAssistantTurn(ctx, services, input, stepIndex, deps.currentTurn());
  state.journaled = true;
  deps.gate.noteToolTurn();
}

/**
 * Shared types for the pi-agent-core inner-turn driver.
 */
import type { BrainContext } from '../../../../contracts/index.js';
import type { RunCancellation } from '../../services/cancel.js';
import type { CardRetryBudget, NoReplyBudget, ReplyCitation } from '../../services/final-reply.js';
import type { PromiseRetryBudget } from '../../services/promise-check.js';
import type { RunContext, RunInput, RunServices } from '../../services/run-types.js';
import type { RunBudget } from '../../services/run-budget.js';
import type { SettleDecision, TodoGate } from '../../services/todo-gate.js';
import type { CompactionLog } from './turn-context.js';

/** Bounded continuations of a token-limit stop, shared across the run's outer steps. */
export interface LengthBudget {
  count: number;
}

/** Everything one inner-turn invocation needs; the runner stays the durable owner of all of it. */
export interface CoreTurnDeps {
  goalBrowserMode?: boolean;
  /** The chat takes reactions, so `react` is one of the core tools (constant per conversation, journaled once per run). */
  reactions?: boolean;
  /** The chat is an app room with several agents, so `message_agent` is a core tool (constant per conversation, journaled once per run). */
  roomTalk?: boolean;
  ctx: RunContext;
  services: RunServices;
  input: RunInput;
  runId: string;
  stepIndex: number;
  brainCtx: BrainContext;
  cancellation: RunCancellation;
  deliveredTexts: string[];
  /** Run-wide: sources web tools returned, attached to the final reply bubble. */
  citations: ReplyCitation[];
  /** Run-wide: set once the model starts working with tools; later previews stay silent. */
  progress: { working: boolean };
  gate: TodoGate;
  lengthBudget: LengthBudget;
  /** Run-wide: the one retry a reply with an invalid card gets. */
  cardRetry: CardRetryBudget;
  /** Run-wide: the one retry a reply that promises something later without scheduling it gets. */
  promiseRetry: PromiseRetryBudget;
  /** Run-wide: the one retry an empty or refused final turn gets when someone is waiting. */
  noReply: NoReplyBudget;
  /** The run's frozen usage/budget authority; the model step charges and checks it before tools. */
  budget: RunBudget;
  /** Run-wide: the steps at which this run compacted, for the "compacting does not help" guard. */
  compactions: CompactionLog;
}

/** How one outer step ended; `continued` means the same run keeps working. */
export interface CoreTurnResult {
  outcome: 'stopped' | SettleDecision;
  brainCtx: BrainContext;
}

/** Mutable per-turn state shared by the driver, its journal sink and its hooks. */
export interface TurnState {
  /** The run was stopped or cancelled; no further durable effect may be written. */
  stopped: boolean;
  /** The authoritative assistant turn is already in the transcript. */
  journaled: boolean;
  /** A correction superseded this turn, so nothing else about it may be persisted. */
  steeredInFlight: boolean;
  /** Tool-call ids the product adapter already wrote a result for. */
  persisted: Set<string>;
}

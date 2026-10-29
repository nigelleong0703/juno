/**
 * Shared types for the pi-agent-core inner-turn driver.
 */
import type { BrainContext } from '../../../../contracts/index.js';
import type { RunCancellation } from '../../services/cancel.js';
import type { CardRetryBudget, ReplyCitation } from '../../services/final-reply.js';
import type { RunContext, RunInput, RunServices } from '../../services/run-types.js';
import type { RunBudget } from '../../services/run-budget.js';
import type { SettleDecision, TodoGate } from '../../services/todo-gate.js';

/** Bounded continuations of a token-limit stop, shared across the run's outer steps. */
export interface LengthBudget {
  count: number;
}

/** Everything one inner-turn invocation needs; Restate stays the durable owner of all of it. */
export interface CoreTurnDeps {
  goalBrowserMode?: boolean;
  /** The chat takes reactions, so `react` is one of the core tools (constant per conversation, journaled once per run). */
  reactions?: boolean;
  /** Nobody is waiting on this run (`offersQuietExit`), so `finish_quietly` is one of its tools (constant for the run, journaled once). */
  quietExit?: boolean;
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
  /** The run's frozen usage/budget authority; the model step charges and checks it before tools. */
  budget: RunBudget;
  /** Bounded visible-text seam for the run-stream helper (PH4); never raw reasoning. */
  onDelta?: (text: string) => void;
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

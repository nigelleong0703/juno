/**
 * Routine business-task domain: completion, read, history and pause policies (BACKEND 5.2.1).
 *
 * This module owns the *policies*; the Restate Harness adapter (routineTimer) only loads durable
 * state, calls these pure transitions, and persists the result. Nothing here touches Restate,
 * the store, or the network, so every rule below has a direct unit regression.
 *
 * Core meaning: a generated output is *unread* until a read receipt with a cutoff at or past its
 * time arrives. Generating an item never counts as reading it. A late read (cutoff at or before
 * the recorded watermark) changes nothing, and a read never clears results produced after it.
 */

export const UNREAD_PAUSE_AFTER = 5;
export const FAIL_PAUSE_AFTER = 5;
export const ROUTINE_RUN_HISTORY_LIMIT = 20;
export const MAX_READ_RESULT_IDS = 200;

/** Durable policy record for one routine; stored by the adapter, interpreted here. */
export interface RoutinePolicyState {
  unreadStreak: number;
  failStreak: number;
  /** Max output time accounted so far; a read at/after this clears the streak. */
  lastResultAt?: string;
  /** Monotonic read watermark; older cutoffs never rewind it. */
  lastReadCutoff?: string;
}

export function emptyPolicyState(): RoutinePolicyState {
  return { unreadStreak: 0, failStreak: 0 };
}

export interface CompletionInput {
  succeeded: boolean;
  /** Visible outputs this run produced; negative or fractional input is clamped. */
  itemsGenerated: number;
  /** Completion time (ISO); carried onto the history record and lastResultAt. */
  at: string;
}

export type PauseReason = 'unread' | 'failed';

export interface CompletionDecision {
  unreadStreak: number;
  failStreak: number;
  lastResultAt?: string;
  paused: false | { reason: PauseReason };
}

/**
 * One finished routine run moves the streaks. Success resets failures; outputs add to the unread
 * streak (each produced item is one unread result). A silent success changes no unread state.
 * A failure only moves the failure streak. Pause fires exactly when a threshold is reached.
 */
export function applyCompletion(state: RoutinePolicyState, input: CompletionInput): CompletionDecision {
  if (!input.succeeded) {
    const failStreak = state.failStreak + 1;
    return {
      unreadStreak: state.unreadStreak,
      failStreak,
      ...(state.lastResultAt === undefined ? {} : { lastResultAt: state.lastResultAt }),
      paused: failStreak >= FAIL_PAUSE_AFTER ? { reason: 'failed' } : false,
    };
  }
  const produced = Math.max(0, Math.floor(input.itemsGenerated));
  if (produced === 0) {
    return {
      unreadStreak: state.unreadStreak,
      failStreak: 0,
      ...(state.lastResultAt === undefined ? {} : { lastResultAt: state.lastResultAt }),
      paused: false,
    };
  }
  const unreadStreak = state.unreadStreak + produced;
  const lastResultAt = state.lastResultAt === undefined || input.at > state.lastResultAt ? input.at : state.lastResultAt;
  return {
    unreadStreak,
    failStreak: 0,
    lastResultAt,
    paused: unreadStreak >= UNREAD_PAUSE_AFTER ? { reason: 'unread' } : false,
  };
}

export interface ReadInput {
  /** Read time (ISO) from the authorized mark-read route; the evidence cutoff. */
  readCutoff: string;
}

export interface ReadDecision {
  unreadStreak: number;
  lastReadCutoff: string;
  /** True when this read actually cleared unread results. */
  cleared: boolean;
}

/**
 * An authorized read advances the monotonic watermark. It clears the streak only when its cutoff
 * reaches the newest accounted result; a late or duplicate read changes nothing, and results
 * produced after the cutoff keep their streak.
 */
export function applyRead(state: RoutinePolicyState, input: ReadInput): ReadDecision {
  if (state.lastReadCutoff !== undefined && input.readCutoff <= state.lastReadCutoff) {
    return { unreadStreak: state.unreadStreak, lastReadCutoff: state.lastReadCutoff, cleared: false };
  }
  const clears = state.lastResultAt === undefined || input.readCutoff >= state.lastResultAt;
  return { unreadStreak: clears ? 0 : state.unreadStreak, lastReadCutoff: input.readCutoff, cleared: clears };
}

/** Append one run record, keeping the newest entries within the history bound. */
export function appendHistory<T>(runs: readonly T[], entry: T, limit: number = ROUTINE_RUN_HISTORY_LIMIT): T[] {
  return [...runs, entry].slice(-limit);
}

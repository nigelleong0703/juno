import type { Brain, Store, ToolRegistry, WakeEvent } from '../../../contracts/index.js';
import type { QueuedEvent } from '../logic/busy.js';
import type { RunInput } from './run-types.js';

/**
 * Stored in Restate state. Objects written by older builds may still carry `busyMode`, `agentBusyMode`,
 * `compactionEpoch`, `lastEventWakeAt` (no longer used) or status 'waiting'/'error'; nothing validates the shape on read,
 * so those keys are simply carried along untouched.
 */
export interface SessionState {
  inbox: QueuedEvent[];
  activeRunId?: string;
  seenWakeIds: string[];
  recentStarts: number[];
  /** Arm token of an in-flight private quiet window; the last message's token wins. */
  pendingFlushToken?: string | null;
  /** When the current quiet window was first armed (epoch ms); caps how long typing can hold the start. */
  pendingSince?: number | null;
  /** The run the armed quiet window will start, named when the window opens so the admitting message can report it (cleared when that run begins). */
  pendingRunId?: string | null;
  /** The user is composing until this time (epoch ms); each typing ping extends it, `active: false` clears it. */
  typingUntil?: number | null;
  status: 'idle' | 'running';
  /** Token of the one-hour idle compaction armed when the session last went idle; a newer one supersedes it. */
  idleCompactToken?: string;
}

/** What a run holding its ready reply reads from the session: is the user still typing, and did a message arrive for it. */
export interface TypingState {
  typingUntil: number | null;
  steerQueued: number;
}

export interface Services {
  store: Store;
  brain: Brain;
  toolRegistry: ToolRegistry;
}

/**
 * Narrow handler surface the Session body needs: its own Restate state, the durable clock/id and the
 * three internal sends it makes. Kept narrow so the owner-scoped body runs under a plain fake in tests;
 * a real ObjectContext is structurally assignable.
 */
export interface SessionIo {
  /** This Session object's key; the canonical `${agentId}:${conversationId}` for the wake. */
  key: string;
  readState(): Promise<SessionState | null>;
  writeState(state: SessionState): void;
  now(): Promise<number>;
  newRunId(): string;
  /** Re-deliver the same wake after the guard's absolute time (a delayed self-send). */
  deliver(event: WakeEvent, delayMs: number): void;
  /** Arm the durable private idle flush; a newer token supersedes an earlier timer. */
  scheduleFlush(token: string, delayMs: number): void;
  /** Arm the background compaction of a quiet chat; a newer token supersedes an earlier timer. */
  scheduleIdleCompact(token: string, delayMs: number): void;
  startRun(runId: string, input: RunInput): void;
  cancelRun(runId: string): void;
}

export function defaultState(): SessionState {
  return {
    inbox: [],
    seenWakeIds: [],
    recentStarts: [],
    status: 'idle',
  };
}

export const MAX_SEEN_WAKE_IDS = 500;

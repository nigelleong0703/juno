import type { BlobStore, Enqueuer, Store, ToolRegistry } from '../../../contracts/index.js';
import type { RunCapabilities } from '../../../modules/tasks/routines/runNote.js';

export interface TimerState {
  routineId: string;
  nextRunAtTime?: string;
  armed: boolean;
  /** Arm generation: a delayed fire carrying an older generation is stale and skipped. */
  armGeneration: number;
  failStreak: number;
  unreadStreak: number;
  /** Newest accounted output time; a read at/after this clears the streak. */
  lastResultAt?: string;
  /** Monotonic read watermark; older cutoffs never rewind it. */
  lastReadCutoff?: string;
  /** Recent read evidence (bounded); audit only, never drives policy. */
  lastReadResultIds?: string[];
  /** Epoch-ms occurrence keys already delivered; bounded, so retries never duplicate. */
  firedOccurrences: number[];
  /** Set when auto-paused; cleared on re-enable so the next enable starts fresh. */
  pausedAt?: string;
  lastFiredAt?: string;
}

export function defaultState(routineId: string): TimerState {
  return { routineId, armed: false, armGeneration: 0, failStreak: 0, unreadStreak: 0, firedOccurrences: [] };
}

/** States journaled before a field existed still load: absent fields read as their defaults. */
export function withDefaults(state: TimerState): TimerState {
  return {
    ...state,
    armGeneration: state.armGeneration ?? 0,
    failStreak: state.failStreak ?? 0,
    unreadStreak: state.unreadStreak ?? 0,
    firedOccurrences: state.firedOccurrences ?? [],
  };
}

export interface Services {
  store: Store;
  enqueuer: Enqueuer;
  /** What the platform offers a run (web search, a computer); the run context tells the agent. Absent = neither. */
  capabilities?: RunCapabilities;
  /** Whether an agent can use the owner's Mac now (for `mac` in a routine's `requires`). */
  macUsable?: (agentId: string) => Promise<boolean>;
  /** What a monitor's check runs its read-only tool call with; without them a monitor cannot check. */
  tools?: ToolRegistry;
  blobs?: BlobStore;
  /** Whether monitors (routines with a `check` trigger) run: false while the host's monitors plugin is off; their routines are kept and paused. Absent: they run. */
  monitorChecks?: boolean;
}

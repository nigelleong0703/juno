import { RestatePromise, type RestatePromise as RestatePromiseType } from '@agent-desktop/durable';

/** Unique sentinel resolved when a durable race loses to the run's cancel signal. */
export const CANCELLED = Symbol('cancelled');

interface CancelState {
  cancelled: boolean;
}

/** The durable cancel signal a real Run exposes (ctx.promise('cancel') satisfies this structurally). */
export interface CancelSource {
  peek(): Promise<boolean | undefined>;
  get(): RestatePromiseType<boolean>;
}

/**
 * One per-run cancellation: an AbortSignal for cooperative model/tool work plus a durable cancel
 * race. Nothing here uses a native Promise.race on Restate promises: the race is
 * `RestatePromise.race`, so a real Restate invocation stays replay-safe, while a test double that
 * hands back SDK-branded promises travels the same path.
 */
export interface RunCancellation {
  /** Aborted when the run is cancelled, so cooperative model/tool calls stop early. */
  readonly signal: AbortSignal;
  /** In-memory mirror of the durable cancel state; checked before durable writes. */
  readonly state: CancelState;
  /** Durable check: has the cancel promise been resolved? */
  peek(): Promise<boolean>;
  /**
   * Race a Restate promise (a real ctx.run) against the durable cancel signal. `start` is lazy so an
   * already-cancelled run schedules no new durable effect; it returns the SDK promise itself (never a
   * native wrapper), so the durable context is kept. `T` is inferred and is never a symbol.
   */
  race<T>(start: () => RestatePromiseType<T>): Promise<T | typeof CANCELLED>;
  /** Mark the run cancelled and abort cooperative work. Safe to call more than once. */
  abort(): void;
}

function markCancelled(state: CancelState, controller: AbortController): void {
  state.cancelled = true;
  controller.abort();
}

/** Neutral cancellation for callers running without a durable cancel signal. Never cancels. */
export const NEVER_CANCELLED: RunCancellation = {
  signal: new AbortController().signal,
  state: { cancelled: false },
  async peek(): Promise<boolean> {
    return false;
  },
  race<T>(start: () => RestatePromiseType<T>): Promise<T | typeof CANCELLED> {
    return start();
  },
  abort(): void {},
};

/** `leaseSignal` (when present) aborts the same cooperative work: a worker that lost its lease must stop at once. */
export function createRunCancellation(cancelSignal: CancelSource, leaseSignal?: AbortSignal): RunCancellation {
  const controller = new AbortController();
  const state: CancelState = { cancelled: false };
  const abort = (): void => markCancelled(state, controller);
  if (leaseSignal !== undefined) {
    if (leaseSignal.aborted) abort();
    else leaseSignal.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    state,
    async peek(): Promise<boolean> {
      if (state.cancelled) return true;
      return (await cancelSignal.peek()) === true;
    },
    async race<T>(start: () => RestatePromiseType<T>): Promise<T | typeof CANCELLED> {
      if (state.cancelled) return CANCELLED;
      const cancel = cancelSignal.get().then((): typeof CANCELLED => CANCELLED);
      const outcome = await RestatePromise.race([start(), cancel]);
      if (outcome === CANCELLED) {
        abort();
        return CANCELLED;
      }
      return outcome;
    },
    abort,
  };
}

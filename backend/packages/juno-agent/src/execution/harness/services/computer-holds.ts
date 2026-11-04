/**
 * While a run is in progress the owner's computer is never paused (BACKEND §7.3b). Each run places one hold on the computer
 * (`ComputerClient.hold`, passive: it never wakes, creates or starts anything), renews it while the run lives in this process and
 * releases it when the run ends in any way. The renewal is also what ends a hold nobody released: a worker that crashed or lost its
 * lease stops renewing and the hold lapses by itself after `HOLD_TTL_MS`.
 *
 * A run parked on the person (approval, answer, sign-in, take-over: `awaitUser`) keeps its hold for `PARKED_RELEASE_MS`, then releases
 * it so a computer nobody is working on can pause; the answer places it again. Everything here is best effort: a failed call is logged,
 * the next renewal tries again, and a computer that pauses anyway is resumed by the next tool call like any sleeping computer.
 */
import { randomUUID } from 'node:crypto';
import type { ComputerClient } from '../../../ports/computer/index.js';

/** How often a live run renews its hold. */
export const HOLD_RENEW_MS = 30_000;
/** How long a hold lasts without a renewal: a worker that died frees the computer this long after its last renewal. */
export const HOLD_TTL_MS = 3 * HOLD_RENEW_MS;
/** A run waiting on the person for longer than this lets the computer pause. */
export const PARKED_RELEASE_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 10_000;

export interface ComputerHolds {
  /** The run started (call inside its owner scope: the timers keep it). Replaces a hold the same run id still has. */
  begin(agentId: string, runId: string): void;
  /** The run now waits on the person. Returns the function to call when it stops waiting. */
  parked(runId: string): () => void;
  /** The run ended, however it ended (call inside its owner scope). */
  end(runId: string): void;
}

interface Entry {
  agentId: string;
  /** One id per execution of the run body, so a frozen old worker waking up cannot release the hold its successor placed. */
  holdId: string;
  held: boolean;
  parks: number;
  renewTimer: ReturnType<typeof setInterval> | undefined;
  parkTimer: ReturnType<typeof setTimeout> | undefined;
  /** The calls of this hold, one after another, so a release can never overtake its own placement. */
  calls: Promise<void>;
}

export function createComputerHolds(computer: ComputerClient | undefined, log?: (fields: Record<string, unknown>, message: string) => void): ComputerHolds | undefined {
  if (computer?.hold === undefined || computer.release === undefined) return undefined;
  const entries = new Map<string, Entry>();

  const call = (entry: Entry, action: 'hold' | 'release'): void => {
    entry.calls = entry.calls
      .then(() => {
        const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
        return action === 'hold'
          ? computer.hold?.(entry.agentId, entry.holdId, HOLD_TTL_MS, signal)
          : computer.release?.(entry.agentId, entry.holdId, signal);
      })
      .catch((error: unknown) => log?.({ err: error, hold: entry.holdId, action }, 'computer hold call failed'));
  };

  const place = (entry: Entry): void => {
    entry.held = true;
    call(entry, 'hold');
    entry.renewTimer = setInterval(() => call(entry, 'hold'), HOLD_RENEW_MS);
    entry.renewTimer.unref();
  };

  const drop = (entry: Entry): void => {
    if (entry.renewTimer !== undefined) clearInterval(entry.renewTimer);
    entry.renewTimer = undefined;
    if (entry.parkTimer !== undefined) clearTimeout(entry.parkTimer);
    entry.parkTimer = undefined;
    if (!entry.held) return;
    entry.held = false;
    call(entry, 'release');
  };

  return {
    begin(agentId, runId) {
      const previous = entries.get(runId);
      if (previous !== undefined) drop(previous);
      const entry: Entry = { agentId, holdId: `run:${runId}:${randomUUID().slice(0, 8)}`, held: false, parks: 0, renewTimer: undefined, parkTimer: undefined, calls: Promise.resolve() };
      entries.set(runId, entry);
      place(entry);
    },

    parked(runId) {
      const entry = entries.get(runId);
      if (entry === undefined) return () => undefined;
      entry.parks += 1;
      if (entry.parks === 1) {
        entry.parkTimer = setTimeout(() => {
          entry.parkTimer = undefined;
          drop(entry);
        }, PARKED_RELEASE_MS);
        entry.parkTimer.unref();
      }
      let done = false;
      return () => {
        if (done) return;
        done = true;
        entry.parks -= 1;
        if (entry.parks > 0 || entries.get(runId) !== entry) return;
        if (entry.parkTimer !== undefined) clearTimeout(entry.parkTimer);
        entry.parkTimer = undefined;
        if (!entry.held) place(entry);
      };
    },

    end(runId) {
      const entry = entries.get(runId);
      if (entry === undefined) return;
      entries.delete(runId);
      drop(entry);
    },
  };
}

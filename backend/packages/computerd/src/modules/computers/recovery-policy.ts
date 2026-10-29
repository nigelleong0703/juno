/** The pure parts of computer recovery (BACKEND §7.11, fault tolerance): timing and classification. */
import { StaleComputerError } from '@agent-desktop/sandbox-adapters';

/** Delay before the next attempt after `failures` consecutive failed ones: 5 s, 10 s, 20 s ... capped at 2 min. Recovery never gives up. */
export const BACKOFF_FIRST_MS = 5_000;
export const BACKOFF_MAX_MS = 120_000;
/** Consecutive failed attempts from which the log turns loud (an operator has to look). */
export const ALERT_AFTER_FAILURES = 3;
/** How long one call waits for a recovery before telling the agent the computer is being restored. */
export const RECOVERY_WAIT_MS = 90_000;
/** Recoveries one request may trigger: the original try, then at most this many replacements. */
export const MAX_RECOVERIES_PER_REQUEST = 2;

export function backoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (consecutiveFailures - 1));
}

/** The error means the bound computer is unusable and a replacement fixes it (it was raised before anything reached the computer). */
export function staleOf(error: unknown): StaleComputerError | undefined {
  return error instanceof StaleComputerError ? error : undefined;
}

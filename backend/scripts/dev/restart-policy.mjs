/**
 * Restart backoff for a dev service that exits while the launcher runs (scripts/dev/backend.mjs). The first restart waits 5 s; each
 * further one doubles the wait up to 60 s. A service that stayed up for more than 2 minutes before it exited starts over at 5 s.
 * Pure, so the policy is tested without spawning anything.
 */

export const RESTART_FIRST_MS = 5_000;
export const RESTART_MAX_MS = 60_000;
export const RESTART_RESET_UP_MS = 120_000;

/** The wait before restarting a service: `lastDelayMs` is the wait its previous start used (undefined for the first start). */
export function restartDelayMs({ lastDelayMs, upMs }) {
  if (upMs > RESTART_RESET_UP_MS) return RESTART_FIRST_MS;
  return Math.min((lastDelayMs ?? RESTART_FIRST_MS / 2) * 2, RESTART_MAX_MS);
}

/**
 * A routine occurrence whose run failed because the model provider was unavailable (BACKEND §3.3d.3): rate limited with a wait too long
 * to sleep through in the run, or transient errors that outlasted the run's own retries. Nobody is waiting on such a run, so the SAME
 * occurrence is tried again later, on a durable timer, instead of being lost or counted against the routine.
 */
import type { WakeEvent } from '../../../contracts/index.js';

/** Most re-fires of one occurrence. */
export const REFIRE_MAX = 3;
/** The shortest wait before a re-fire; a longer announced `retry-after` wins. */
export const REFIRE_MIN_DELAY_MS = 5 * 60_000;
/** A re-fire is never later than this after the occurrence's first attempt. */
export const REFIRE_WINDOW_MS = 2 * 60 * 60_000;

/** Which provider failures are an outage worth waiting out (the others are the run's own problem). */
export function isProviderOutage(code: string | undefined): boolean {
  return code === 'quota' || code === 'transient';
}

/** What the terminal error of a failed run says about the provider: an outage (with the announced wait, when there was one), or nothing. */
export function providerOutageOf(error: { metadata: Readonly<Record<string, string>> }): { retryAfterMs?: number } | undefined {
  if (!isProviderOutage(error.metadata['code'])) return undefined;
  const wait = Number(error.metadata['retryAfterMs']);
  return Number.isFinite(wait) && wait > 0 ? { retryAfterMs: wait } : {};
}

/** Where the occurrence stands, carried on the wake payload (`retry`): how many re-fires it already had and when its first attempt started. */
export interface RefireState { attempt: number; firstAttemptAt: string }

export function refireStateOf(wake: Pick<WakeEvent, 'payload'>): RefireState | undefined {
  const raw = wake.payload['retry'];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const attempt: unknown = Reflect.get(raw, 'attempt');
  const first: unknown = Reflect.get(raw, 'firstAttemptAt');
  return typeof attempt === 'number' && typeof first === 'string' ? { attempt, firstAttemptAt: first } : undefined;
}

/**
 * The next re-fire of an occurrence that just failed on a provider outage, or undefined when it has had its last attempt (then the failure counts
 * against the routine). `previous` is the state the failed run's wake carried (none for the first attempt), `startedAt` when that run began.
 */
export function planRefire(input: { previous: RefireState | undefined; startedAt: string; now: number; retryAfterMs: number | undefined }): { delayMs: number; next: RefireState } | undefined {
  const attempt = (input.previous?.attempt ?? 0) + 1;
  if (attempt > REFIRE_MAX) return undefined;
  const firstAttemptAt = input.previous?.firstAttemptAt ?? input.startedAt;
  const delayMs = Math.max(input.retryAfterMs ?? 0, REFIRE_MIN_DELAY_MS);
  if (input.now + delayMs > Date.parse(firstAttemptAt) + REFIRE_WINDOW_MS) return undefined;
  return { delayMs, next: { attempt, firstAttemptAt } };
}

/** The wake for the next attempt: the same occurrence (payload, `at`) under a new id, so the session accepts it, with a line saying it is a retry. */
export function refireWake(wake: WakeEvent, next: RefireState): WakeEvent {
  const text = typeof wake.payload['text'] === 'string' ? wake.payload['text'] : '';
  return {
    ...wake,
    id: wake.id.replace(/_r\d+$/, '') + '_r' + String(next.attempt),
    payload: {
      ...wake.payload,
      text: text.replace(/\n\n\[This is a retry:[^\]]*\]$/, '') + '\n\n[This is a retry: the AI provider was unavailable earlier. Write for the time it is now.]',
      retry: next,
    },
    status: 'accepted',
  };
}

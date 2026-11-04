/**
 * The sentences a person reads when a run ends badly (BACKEND §3.3d.5 point 8): one plain sentence each, no provider text, no status codes,
 * no internal names or ids. The raw error stays in the logs (and, for a tool call, on the step and the audit row); it never reaches
 * `Run.error`, the task row or a push.
 */
import type { ModelFailureKind } from '../../brain/model-failure.js';

/** The conversation outgrew what one go can hold, even after it was compacted (or compacting did not help). */
export const CONVERSATION_TOO_LONG = 'This conversation got too long to continue in one go.';
/** The provider rate-limited or is out of quota. */
export const MODEL_BUSY = 'The model service is busy right now. Try again in a few minutes.';
/** The provider is down, answered with a server error, or could not be reached. */
export const MODEL_UNREACHABLE = "Couldn't reach the model service. Try again shortly.";
/** The sign-in or key for the person's model provider is missing, invalid or expired. */
export const MODEL_NEEDS_SETTINGS = 'Your model provider needs attention in Settings.';
/** Anything else that went wrong inside the platform. */
export const SOMETHING_WENT_WRONG = 'Something went wrong on our side. Try again.';

/** The failed run's reason line when the model answered nothing twice, or the provider refused (the stability batch's sentences). */
export const NO_REPLY_FAILURE = 'The model gave no answer, twice in a row, so nothing was sent. Please try again.';
export const REFUSED_FAILURE = 'The model declined to answer (the provider refused the request), so nothing was sent. Please try again or rephrase.';

/** The model took too long to start or went quiet mid-answer (stream-watchdog.ts): already plain, so these stay as they are. */
export const MODEL_TIMEOUTS: readonly string[] = ['Model response timed out before any progress. Please retry.', 'Model stream timed out without further progress. Please retry.'];

/** Every sentence a failed run's `error` may hold when a person reads it. A failed run's error that is not one of them is shown as `SOMETHING_WENT_WRONG`. */
const PLAIN_FAILURES: ReadonlySet<string> = new Set([
  CONVERSATION_TOO_LONG, MODEL_BUSY, MODEL_UNREACHABLE, MODEL_NEEDS_SETTINGS, SOMETHING_WENT_WRONG, NO_REPLY_FAILURE, REFUSED_FAILURE, ...MODEL_TIMEOUTS,
  'The run stopped after repeated internal errors. Send the message again to retry.',
]);

/**
 * The line the task row shows for a run that did not finish (BACKEND §6.5). A blocked run's reason is written for the person where it is
 * blocked (`markRunBlocked`), so it is shown as it is; a failed run's error only when it is one of our plain sentences, so a row stored
 * before the mapping existed (provider text, status codes, internal codes) reads as the generic sentence instead of leaking.
 */
export function failureLineOf(run: { status: string; error?: string }): string | undefined {
  if (run.error === undefined) return undefined;
  if (run.status === 'blocked') return run.error;
  return PLAIN_FAILURES.has(run.error) ? run.error : SOMETHING_WENT_WRONG;
}

/** What a failed model call means for the person, by the kind the provider failure was classified as (`classifyProviderFailure`). */
export function plainProviderFailure(kind: ModelFailureKind): string {
  switch (kind) {
    case 'quota': return MODEL_BUSY;
    case 'transient': return MODEL_UNREACHABLE;
    case 'auth': return MODEL_NEEDS_SETTINGS;
    case 'context_overflow': return CONVERSATION_TOO_LONG;
    case 'invalid_request': return SOMETHING_WENT_WRONG;
  }
}

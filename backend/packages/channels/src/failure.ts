/**
 * What a failed send means for the outbox (BACKEND 5.7.11). Each platform knows its own refusals; this is the one vocabulary they answer in:
 * `transient` (network, 5xx, rate limit: try again later, honouring `retryAfterMs`) or a permanent kind that is never retried.
 * A failure with no kind is treated as transient, so an unknown error is retried a bounded number of times and then dropped, never lost silently.
 */
export type SendFailureKind = 'transient' | 'channel_gone' | 'token_invalid' | 'content_rejected';

export interface SendFailure {
  kind: SendFailureKind;
  /** The platform's own "wait this long" (Telegram `retry_after`, Slack/Discord `Retry-After`), in milliseconds. */
  retryAfterMs?: number;
}

/** The generic reading of an HTTP status: no answer (0), timeout, rate limit and 5xx are transient; 401 is the credential; 403/404 the chat; other 4xx this message. */
export function httpFailure(status: number, retryAfterMs?: number): SendFailure {
  const kind: SendFailureKind = status === 0 || status === 408 || status === 429 || status >= 500 ? 'transient'
    : status === 401 ? 'token_invalid'
      : status === 403 || status === 404 ? 'channel_gone'
        : 'content_rejected';
  return { kind, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

/** A `Retry-After` header (whole seconds) or a body value in seconds, as milliseconds; undefined when it says nothing usable. */
export function retryAfterMsOf(seconds: unknown): number | undefined {
  const value = typeof seconds === 'string' && seconds.trim() !== '' ? Number(seconds) : seconds;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.ceil(value * 1000) : undefined;
}

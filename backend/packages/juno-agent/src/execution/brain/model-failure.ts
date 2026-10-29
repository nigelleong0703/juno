/**
 * Provider failure classification (PH5).
 *
 * Restate retries any thrown error unboundedly, so the run must decide what a provider failure means
 * from the SDK's own signals, never from a loosened message parse. The qualified mechanics are the
 * adapter's `onResponse` hook (HTTP status + headers), pi-ai's `isRetryableAssistantError` and
 * `isContextOverflow` predicates over the failed AssistantMessage, and the `retry-after` HTTP header
 * convention pi-ai itself uses. A classification is durable-run evidence: auth and invalid requests
 * are terminal, quota and transient failures get a bounded retry, and context overflow gets exactly
 * one compaction before it becomes terminal.
 */
import type { AssistantMessage, ProviderResponse } from '@earendil-works/pi-ai';
import { isContextOverflow, isRetryableAssistantError } from '@earendil-works/pi-ai';
import type { ModelTurnErrorCode } from './model-turn-error.js';

export type ModelFailureKind = 'auth' | 'quota' | 'transient' | 'context_overflow' | 'invalid_request';

export interface ProviderFailure {
  kind: ModelFailureKind;
  code: ModelTurnErrorCode;
  /** Truthful, user-facing reason; never a bare 'Model API error'. */
  message: string;
  retryAfterMs?: number;
}

/** A provider failure with its classification, so the run can decide rather than Restate retrying it. */
export class ProviderFailureError extends Error {
  constructor(readonly failure: ProviderFailure) {
    super(failure.message);
    this.name = 'ProviderFailureError';
  }
}

/** The HTTP status the adapter observed for this request, when it exposes one. */
export function responseStatus(response: ProviderResponse | undefined): number | undefined {
  if (response === undefined) return undefined;
  return typeof response.status === 'number' ? response.status : undefined;
}

/** `retry-after` (seconds or HTTP-date) or `retry-after-ms`, following pi-ai's own convention. */
export function retryAfterMsOf(response: ProviderResponse | undefined): number | undefined {
  const headers: unknown = response?.headers;
  if (typeof headers !== 'object' || headers === null) return undefined;
  const get = (name: string): string | undefined => {
    const value: unknown = Reflect.get(headers, name);
    return typeof value === 'string' ? value : undefined;
  };
  // `retry-after-ms` is already milliseconds; only `retry-after` is seconds or an HTTP-date.
  const milliseconds = get('retry-after-ms');
  if (milliseconds !== undefined && milliseconds.length > 0) {
    const value = Number.parseFloat(milliseconds);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
  }
  const after = get('retry-after');
  if (after === undefined || after.length === 0) return undefined;
  const seconds = Number.parseFloat(after);
  const delay = Number.isNaN(seconds) ? Date.parse(after) - Date.now() : seconds * 1000;
  return Number.isFinite(delay) && delay > 0 ? Math.round(delay) : undefined;
}

function detailOf(message: AssistantMessage | undefined, status: number | undefined): string {
  const reported = message?.errorMessage;
  if (reported !== undefined && reported.length > 0) return reported;
  return status === undefined ? 'the model request failed' : 'the provider returned status ' + String(status);
}

/**
 * Classify one provider failure. Status decides first (401/403 auth, 429 quota, 408/409/5xx transient,
 * other 4xx invalid); without a status pi-ai's own overflow and retryability predicates decide.
 */
export function classifyProviderFailure(
  message: AssistantMessage | undefined,
  response: ProviderResponse | undefined,
  contextWindow: number | undefined,
): ProviderFailure {
  const status = responseStatus(response);
  const retryAfterMs = retryAfterMsOf(response);
  const detail = detailOf(message, status);
  const retry = retryAfterMs === undefined ? {} : { retryAfterMs };
  // The adapter only observes a successful HTTP response, so a failed request carries its status in
  // pi-ai's own normalized error text (<status>: <body> / <prefix> (<status>): <body>). The anchored
  // shapes below are exactly that documentation, not a general message scrape.
  const code = status ?? sdkStatus(message?.errorMessage);
  if (code === 401 || code === 403) {
    return { kind: 'auth', code: 'auth', message: 'Model authentication failed (' + String(code) + '): ' + detail };
  }
  if (code === 429) {
    return { kind: 'quota', code: 'quota', message: 'Model quota exhausted (429): ' + detail, ...retry };
  }
  if (message !== undefined && isContextOverflow(message, contextWindow)) {
    return { kind: 'context_overflow', code: 'context_overflow', message: 'Model context overflow: ' + detail };
  }
  if (code !== undefined && code >= 400 && code < 500 && code !== 408 && code !== 409) {
    return { kind: 'invalid_request', code: 'invalid_request', message: 'Model request rejected (' + String(code) + '): ' + detail };
  }
  if (code === undefined && message !== undefined && !isRetryableAssistantError(message)) {
    return { kind: 'invalid_request', code: 'invalid_request', message: 'Model request failed: ' + detail };
  }
  return { kind: 'transient', code: 'transient', message: 'Model request failed: ' + detail, ...retry };
}

/**
 * The HTTP status pi-ai's normalized provider error text carries, when one of its documented shapes
 * matches: `<prefix> (<status>): <body>`, `<status>: <body>`, or `<status> status code (no body)`.
 */
function sdkStatus(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const prefixed = /^\s*[^:()]{0,60}\((\d{3})\):/;
  const bare = /^\s*(\d{3})(?::| status code)/;
  const match = prefixed.exec(text) ?? bare.exec(text);
  if (match === null || match[1] === undefined) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : undefined;
}

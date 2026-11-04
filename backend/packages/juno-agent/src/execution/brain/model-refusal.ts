/**
 * When the provider declines to answer (BACKEND §3.3 "empty or refused final reply"). What each wire reports, read from the pi-ai adapters
 * the provider calls (node_modules/@earendil-works/pi-ai/dist/api):
 *  - chat completions: `finish_reason: "content_filter"` -> the stream ends in an error event whose `rawStopReason` is `content_filter`;
 *  - Responses: `response.incomplete` with `incomplete_details.reason: "content_filter"` -> `rawStopReason` is `incomplete.content_filter`;
 *    a refusal content item (`response.refusal.delta` / `.done`) arrives as ordinary text on a *completed* response, so only the event says so;
 *  - Anthropic messages: `stop_reason: "refusal"` -> `rawStopReason` is `refusal`.
 * Every other error stop (a failed or cancelled response, an unknown finish reason) stays a provider failure.
 */

const REFUSAL_RAW_STOPS: ReadonlySet<string> = new Set(['content_filter', 'incomplete.content_filter', 'refusal']);

/** The adapter's recorded stop reason of a response the provider refused. */
export function isRefusalStop(rawStopReason: string | undefined): boolean {
  return rawStopReason !== undefined && REFUSAL_RAW_STOPS.has(rawStopReason);
}

/** A Responses stream event that carries a refusal (not an ordinary output text). */
export function isRefusalEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const type: unknown = Reflect.get(event, 'type');
  return type === 'response.refusal.delta' || type === 'response.refusal.done';
}

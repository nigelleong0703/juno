export type ModelTurnErrorCode =
  | 'first_response_timeout'
  | 'stream_idle_timeout'
  | 'output_budget'
  | 'auth'
  | 'quota'
  | 'transient'
  | 'context_overflow'
  | 'invalid_request';

export class ModelTurnError extends Error {
  constructor(
    readonly code: ModelTurnErrorCode,
    message: string,
    /** Provider-advertised retry delay, when the response carried one (seconds or HTTP-date). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ModelTurnError';
  }
}

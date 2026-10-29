/**
 * Typed errors. Every rejection from the SDK is a `JunoError`; server rejections are `JunoApiError`
 * and carry the server's own `{ code, message }` (for example `CONVERSATION_NOT_FOUND`).
 */

export class JunoError extends Error {
  /** Machine-readable code: the server's `error.code`, or an SDK code such as `NETWORK_ERROR` or `CLOSED`. */
  readonly code: string;
  /** HTTP status when the failure came from a response. */
  readonly status: number | undefined;

  constructor(code: string, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'JunoError';
    this.code = code;
    this.status = options.status;
  }
}

/** The server answered with a non-2xx status. */
export class JunoApiError extends JunoError {
  declare readonly status: number;
  /** Per-field reasons of a 400 (`error.fields`). */
  readonly fields: Record<string, string> | undefined;
  /** How long to wait before retrying a 429 (`error.retryAfterSec`). */
  readonly retryAfterSec: number | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { fields?: Record<string, string>; retryAfterSec?: number } = {},
  ) {
    super(code, message, { status });
    this.name = 'JunoApiError';
    this.fields = options.fields;
    this.retryAfterSec = options.retryAfterSec;
  }
}

/** The transport's HTTP error shape (`packages/client` `createError`): a plain Error with `status` and `code`. */
interface TransportError {
  name: 'HttpError';
  message: string;
  status: number;
  code: string;
  fields?: Record<string, string>;
  retryAfterSec?: number;
}

function isTransportError(error: unknown): error is TransportError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Partial<TransportError>;
  return candidate.name === 'HttpError' && typeof candidate.status === 'number' && typeof candidate.code === 'string';
}

/** Map anything a client call throws onto the SDK's typed errors. */
export function toJunoError(error: unknown): JunoError {
  if (error instanceof JunoError) return error;
  if (isTransportError(error)) {
    return new JunoApiError(error.status, error.code, error.message, {
      ...(error.fields ? { fields: error.fields } : {}),
      ...(error.retryAfterSec !== undefined ? { retryAfterSec: error.retryAfterSec } : {}),
    });
  }
  // zod's error class is matched by name so the SDK does not need a second zod copy.
  if (error instanceof Error && error.name === 'ZodError') {
    return new JunoError('INVALID_RESPONSE', 'The server response does not match the Juno contract', { cause: error });
  }
  const message = error instanceof Error ? error.message : 'The request failed';
  return new JunoError('NETWORK_ERROR', message, { cause: error });
}

/** Await a client call and rethrow its failure as a typed `JunoError`. */
export async function guard<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    throw toJunoError(error);
  }
}

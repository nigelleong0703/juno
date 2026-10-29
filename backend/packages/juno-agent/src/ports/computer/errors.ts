/**
 * Stable computer error vocabulary on the computerd wire.
 *
 * Package-owned pure seam: identical constructor/codes to the host
 * `ComputerdError` so the host seam mapping keeps working. No provider
 * implementation here, only the error class plus small constructors.
 */
export type ComputerErrorCode =
  | 'unavailable'
  | 'no_screen'
  | 'user_control'
  | 'not_allowed'
  | 'aborted'
  | 'home_conflict'
  | 'computer_recovering'
  | 'failed';

/** Concrete HTTP statuses so callers accept them as a contentful status. */
export type ComputerHttpStatus = 400 | 403 | 404 | 408 | 409 | 500 | 503;

const HTTP_STATUS: Record<ComputerErrorCode, ComputerHttpStatus> = {
  unavailable: 503,
  no_screen: 404,
  user_control: 409,
  not_allowed: 403,
  aborted: 408,
  home_conflict: 409,
  computer_recovering: 503,
  failed: 500,
};

export class ComputerdError extends Error {
  readonly code: ComputerErrorCode;
  readonly httpStatus: ComputerHttpStatus;

  /** Extra fields of the wire body (a user-control refusal names the surface and who holds it). */
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ComputerErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ComputerdError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.details = details;
  }
}

/** Alias used by agent-side callers; same class, same codes. */
export const ComputerError = ComputerdError;
export type ComputerError = ComputerdError;

export const unavailable = (message: string): ComputerdError =>
  new ComputerdError('unavailable', message);
export const noScreen = (message: string): ComputerdError =>
  new ComputerdError('no_screen', message);
export const userControl = (message: string): ComputerdError =>
  new ComputerdError('user_control', message);
export const notAllowed = (message: string): ComputerdError =>
  new ComputerdError('not_allowed', message);
export const aborted = (message: string): ComputerdError =>
  new ComputerdError('aborted', message);
export const failed = (message: string): ComputerdError =>
  new ComputerdError('failed', message);

export function isComputerErrorCode(value: unknown): value is ComputerErrorCode {
  return (
    value === 'unavailable' ||
    value === 'no_screen' ||
    value === 'user_control' ||
    value === 'not_allowed' ||
    value === 'aborted' ||
    value === 'home_conflict' ||
    value === 'computer_recovering' ||
    value === 'failed'
  );
}

function errorCode(error: Error): unknown {
  if (!('code' in error)) return undefined;
  return error.code;
}

function errorHttpStatus(error: Error): unknown {
  if (!('httpStatus' in error)) return undefined;
  return error.httpStatus;
}

/**
 * Recognize a computer error across module/class identity. Host adapters
 * throw their own provider-local class, so an `instanceof`-only check
 * rejects them; a foreign Error carrying a validated code plus its
 * canonical status is the same contract and must be accepted, while
 * malformed shapes stay rejected.
 */
export function isComputerError(error: unknown): error is ComputerdError {
  if (error instanceof ComputerdError) return true;
  if (!(error instanceof Error)) return false;
  const code = errorCode(error);
  if (!isComputerErrorCode(code)) return false;
  return errorHttpStatus(error) === HTTP_STATUS[code];
}

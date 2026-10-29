/**
 * The stable error vocabulary on the computerd wire (matches \`ComputerErrorCode\` in
 * \`@agent-desktop/tools\`): the runner maps the code onto a tool result, so these strings are a
 * contract, not an implementation detail.
 */
export type ComputerErrorCode =
  | 'unavailable'
  | 'no_screen'
  | 'user_control'
  | 'not_allowed'
  | 'aborted'
  | 'home_conflict'
  /** The platform is replacing a lost computer (retrying with backoff); the call waited and ran out of time, the agent should wait and retry. */
  | 'computer_recovering'
  | 'failed';

/** Concrete HTTP statuses so callers (Hono) accept them as a contentful status without a cast. */
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

  /** Extra fields the wire body carries next to `code` and `message` (a refusal by user control names the surface and who holds it). */
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ComputerErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ComputerdError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.details = details;
  }
}

export const unavailable = (message: string) => new ComputerdError('unavailable', message);
export const noScreen = (message: string) => new ComputerdError('no_screen', message);
export const userControl = (message: string) => new ComputerdError('user_control', message);
export const notAllowed = (message: string) => new ComputerdError('not_allowed', message);
export const aborted = (message: string) => new ComputerdError('aborted', message);
/** A home file changed since the caller read it (`expectedHash` no longer matches). */
export const homeConflict = (message: string) => new ComputerdError('home_conflict', message);
export const failed = (message: string) => new ComputerdError('failed', message);

/** The display's Chromium is gone (its CDP port refuses). Computerd relaunches it and retries once. */
export class BrowserDownError extends ComputerdError {
  readonly displayNo: number;
  constructor(displayNo: number) {
    super('failed', `the browser on screen ${displayNo} closed; restarting`);
    this.name = 'BrowserDownError';
    this.displayNo = displayNo;
  }
}

/** What made a bound computer unusable for good (BACKEND §7.11, fault tolerance). */
export type StaleReason = 'gone' | 'unlinked' | 'link_timeout' | 'image_outdated';

/**
 * The bound computer is gone, predates the computer link, or was started but its link never connected. Thrown BEFORE
 * anything reached the computer, so every action is safe to retry on a new one. computerd recovers (archives the binding,
 * creates a computer on the same durable storage) and retries; this text never reaches the agent unless that fails.
 */
export class StaleComputerError extends ComputerdError {
  readonly reason: StaleReason;
  /** The id of the computer that went stale, so a recovery never replaces a newer, healthy one. */
  readonly computerId: string;
  constructor(reason: StaleReason, message: string, computerId: string) {
    super('unavailable', message);
    this.name = 'StaleComputerError';
    this.reason = reason;
    this.computerId = computerId;
  }
}

export const computerRecovering = (message: string) => new ComputerdError('computer_recovering', message);

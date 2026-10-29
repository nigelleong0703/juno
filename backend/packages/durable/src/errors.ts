/** A failure that must not be retried: the invocation ends and the caller sees the message. */
export class TerminalError extends Error {
  readonly code: number;
  readonly metadata: Readonly<Record<string, string>>;

  constructor(message: string, options?: { errorCode?: number; cause?: unknown; metadata?: Record<string, string> }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TerminalError';
    this.code = options?.errorCode ?? 500;
    this.metadata = options?.metadata ?? {};
  }
}

/** The saved steps of an invocation no longer match the code that replays them (a deploy changed the order or names). */
export class JournalMismatchError extends TerminalError {
  constructor(seq: number, saved: string, expected: string) {
    super(`The run could not continue after an update: its saved step ${String(seq)} was "${saved}" but the code now expects "${expected}".`);
    this.name = 'JournalMismatchError';
  }
}

export const RETRIES_EXHAUSTED_MESSAGE = 'The run stopped after repeated internal errors. Send the message again to retry.';

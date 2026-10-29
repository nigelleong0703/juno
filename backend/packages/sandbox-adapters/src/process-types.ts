/**
 * Async process shapes (see processes.ts). Kept apart from types.ts so neither module grows past the
 * file-size rule; re-exported from types.ts and the package index for one import path.
 *
 * computerd (and the local/e2b providers) run these against the bound sandbox: a command is started
 * detached with its output captured in the sandbox, so a handle stays addressable across separate
 * calls and survives a computerd restart. No PTY is allocated and no host process is ever spawned —
 * a provider that cannot run a background process must say so.
 */
export type ProcessState = 'running' | 'exited' | 'stopped' | 'expired';

export interface ProcessStartInput {
  command: string;
  cwd?: string;
  /** Wall-clock ceiling the sandbox applies to the started process, in milliseconds. */
  timeoutMs?: number;
}

export interface ProcessSnapshot {
  handle: string;
  pid: number | null;
  state: ProcessState;
  exitCode: number | null;
  startedAt: string;
}

export interface ProcessReadInput {
  handle: string;
  /** Byte offset into stdout already consumed; defaults to 0. */
  cursor?: number;
  /** Byte offset into stderr already consumed; defaults to 0. */
  stderrCursor?: number;
  maxBytes?: number;
}

export interface ProcessOutput {
  handle: string;
  state: ProcessState;
  exitCode: number | null;
  /** New stdout bytes since `cursor`, bounded by `maxBytes`. */
  output: string;
  /**
   * New stderr bytes since `stderrCursor`, bounded by `maxBytes`. Kept apart from stdout so a
   * server's diagnostics can never be mistaken for protocol data (e.g. a stdio JSON-RPC stream).
   */
  stderr: string;
  /** Byte offsets to pass back on the next read; neither advances past a partial character. */
  cursor: number;
  stderrCursor: number;
  totalBytes: number;
  stderrTotalBytes: number;
  truncated: boolean;
  stderrTruncated: boolean;
}

export interface ProcessWriteInput {
  handle: string;
  data: string;
}

export interface ProcessWriteResult {
  handle: string;
  bytes: number;
}

export interface ProcessStopInput {
  handle: string;
}

export interface ProcessStopResult {
  handle: string;
  state: ProcessState;
  exitCode: number | null;
}

/** The single result field a process action produces, tagged by which verb it answered. */
export type ProcessResult =
  | { kind: 'started'; snapshot: ProcessSnapshot }
  | { kind: 'read'; output: ProcessOutput }
  | { kind: 'write'; result: ProcessWriteResult }
  | { kind: 'stop'; result: ProcessStopResult };

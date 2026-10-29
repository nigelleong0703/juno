/**
 * Serializable computer request/response shapes for the agent seam.
 *
 * Package-owned pure types used by ComputerClient. Provider-only shapes
 * (host specs, screen handles, action unions) stay with the host.
 */

export type MouseButton = 'left' | 'right' | 'middle';

export interface Screenshot {
  data: string;
  mimeType: string;
  width: number;
  height: number;
  displayNo: number;
}

export interface Point {
  x: number;
  y: number;
  button?: MouseButton;
}

export interface ScrollInput {
  deltaY: number;
  deltaX?: number;
}

export interface ShellInput {
  command: string;
  timeoutMs: number;
  /** Explicit remote working directory from the binding environment. */
  cwd?: string;
}

export interface ShellOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FileContent {
  content: string;
  bytes: number;
}

export interface FileWriteRequest {
  path: string;
  content: string;
}

export interface FileWriteResult {
  path: string;
  bytes: number;
}

export interface NavigateResult {
  url: string;
  title?: string;
}

export interface ComputerMetrics {
  memUsedMb: number;
  memTotalMb: number;
  vcpu: number;
  cpuPercent: number;
  diskUsedGb: number;
  diskTotalGb: number;
}

export interface Resolution {
  width: number;
  height: number;
}

export function parseResolution(value: string): Resolution {
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!match) throw new Error('invalid resolution: ' + value);
  return { width: Number(match[1]), height: Number(match[2]) };
}

export type ProcessState = 'running' | 'exited' | 'stopped' | 'expired';

export interface ProcessStartInput {
  command: string;
  cwd?: string;
  /** Wall-clock ceiling the sandbox applies to the started process, in ms. */
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
  /** New stderr bytes since `stderrCursor`, bounded by `maxBytes`. */
  stderr: string;
  /** Byte offsets to pass back on the next read. */
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

/** The single result field a process action produces, tagged by verb. */
export type ProcessResult =
  | { kind: 'started'; snapshot: ProcessSnapshot }
  | { kind: 'read'; output: ProcessOutput }
  | { kind: 'write'; result: ProcessWriteResult }
  | { kind: 'stop'; result: ProcessStopResult };

/** Debian package names `computer.install_packages` accepts (BACKEND §7.9); one pattern for the tool, the route and the sandbox. */
export const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]+$/;
export const MAX_INSTALL_PACKAGES = 20;

export interface InstallPackagesInput {
  packages: string[];
  /** Why the agent needs them; shown on the approval card. */
  reason: string;
}

export interface InstallPackagesResult {
  /** The tail of apt-get's output. */
  output: string;
}

/** Register an app (BACKEND 5.12): computerd checks, as root, that the port is listened on by this agent's user. */
export interface SpaceRegisterInput {
  spaceId: string;
  port: number;
}

export interface SpaceRegisterResult {
  /** The computer the route was set up on. */
  computerId: string;
}

/** Set by computerd on a response served by a freshly created computer (the old one was lost); the agent is told once. */
export const COMPUTER_RECREATED_HEADER = 'x-computer-recreated';

/** Set by computerd on a response whose action was still running when control of its surface changed hands; the result carries a note. */
export const CONTROL_CHANGED_HEADER = 'x-control-changed';

/** Which of an agent's computers a file or shell call acts on: its sandbox, or the owner's Mac (My Mac). */
export type ComputerTarget = 'sandbox' | 'mac';

/** `computer_copy`: one file or folder between the two computers. Paths are absolute on their own computer. */
export interface ComputerCopyInput {
  from: ComputerTarget;
  to: ComputerTarget;
  path: string;
  toPath: string;
}

export interface ComputerCopyResult {
  /** Where it landed on the destination. */
  toPath: string;
  bytes: number;
  kind: 'file' | 'folder';
}

/** The three ways an agent works an app on the owner's Mac through cua-driver (BACKEND §7.12). */
export type MacDesktopAction = 'snapshot' | 'act' | 'verify';

/** What the Mac answers: text for the model, a small picture sometimes, and whether the app only takes the input in front. */
export interface MacDesktopResult {
  ok: boolean;
  text: string;
  needsForeground?: boolean;
  image?: { mimeType: string; data: string };
}

/** One system-audio recording action on the owner's Mac. Audio bytes stay on the Mac; the result names the local file. */
export type RecordAudioInput =
  | { action: 'start'; maxDurationSeconds?: number }
  | { action: 'stop'; recordingId: string };

export interface RecordAudioResult {
  recordingId: string;
  /** Local path on the computer that recorded the audio. */
  path: string;
  state: 'recording' | 'stopped';
}

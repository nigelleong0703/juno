/**
 * Serializable shapes shared by computerd, the E2B provider and the public screen API.
 *
 * Nothing here carries a VNC password: the provider receives passwords as an input to
 * `ensureScreen` and stores them inside the sandbox, and the HTTP layer only ever returns the
 * redacted screen (see \`@agent-desktop/contracts\` \`ScreenResponse\`).
 */
import type { ScreenState } from '@agent-desktop/contracts';
import type { BrowserInput, BrowserResult } from './browser.js';
import type { MeetInput, MeetResult } from './meet.js';

import type { ProcessReadInput, ProcessResult, ProcessStartInput, ProcessStopInput, ProcessWriteInput } from './process-types.js';

export type { ProcessOutput, ProcessReadInput, ProcessResult, ProcessSnapshot, ProcessStartInput, ProcessState, ProcessStopInput, ProcessStopResult, ProcessWriteInput, ProcessWriteResult } from './process-types.js';


export type MouseButton = 'left' | 'right' | 'middle';
export type ProviderKind = 'e2b' | 'fake' | 'local';
export type SandboxState = 'running' | 'paused';

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
  /**
   * Explicit remote working directory, taken from the binding's environment. The provider
   * passes it to the sandbox runtime; it is never defaulted from the local process.
   */
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

/** What a new sandbox is created with; RAM/vCPU are recorded for the resource projection. */
export interface ComputerHostSpec {
  template: string;
  resolution: string;
  /** IANA timezone the screen's apps run in (TZ), e.g. Asia/Singapore; UTC when absent. */
  timezone?: string;
  timeoutMs: number;
  ramGb: number;
  vcpu: number;
  idlePauseMinutes: number;
}

export interface ScreenRequest {
  /** The agent this display belongs to; keys its Chromium profile. */
  agentId: string;
  displayNo: number;
  resolution: string;
  /** IANA timezone for the screen's apps (browser clock, terminal, office); UTC when absent. */
  timezone?: string;
  /** Read-write x11vnc password; the proxy consumes the challenge with it. */
  controlPassword: string;
  /** Read-only x11vnc password. */
  viewPassword: string;
}

export interface ScreenHandle {
  displayNo: number;
  vncPort: number;
  /** Read-only x11vnc port for watchers. */
  viewVncPort: number;
  webPort: number;
  /** Read-only websockify port for watchers. */
  viewWebPort: number;
  cdpPort: number;
  width: number;
  height: number;
  state: ScreenState;
}

/** Every action the agent or the user can take on a screen; the provider \`act\` switch is exhaustive. */
export type ScreenAction =
  | { kind: 'screenshot' }
  | { kind: 'click'; point: Point }
  | { kind: 'doubleClick'; point: Point }
  | { kind: 'rightClick'; point: Point }
  | { kind: 'move'; point: Point }
  | { kind: 'type'; text: string }
  | { kind: 'key'; key: string }
  | { kind: 'scroll'; input: ScrollInput }
  | { kind: 'navigate'; url: string }
  | { kind: 'browser'; input: BrowserInput }
  | { kind: 'meet'; input: MeetInput }
  | { kind: 'shell'; input: ShellInput }
  | { kind: 'readFile'; path: string }
  | { kind: 'writeFile'; input: FileWriteRequest }
  | { kind: 'clipboardPaste'; input: ClipboardPaste }
  | { kind: 'clipboardCopy'; maxBytes: number }
  | { kind: 'startProcess'; input: ProcessStartInput }
  | { kind: 'readProcess'; input: ProcessReadInput }
  | { kind: 'writeProcess'; input: ProcessWriteInput }
  | { kind: 'stopProcess'; input: ProcessStopInput }
  | { kind: 'startJevMcp' }
  | { kind: 'readJevMcp'; input: ProcessReadInput }
  | { kind: 'writeJevMcp'; input: ProcessWriteInput }
  | { kind: 'stopJevMcp'; input: ProcessStopInput }
  | { kind: 'startScreen' }
  | { kind: 'stopScreen' };

/**
 * The clipboard side channel (M-CLIP): what the device puts on the computer. Bytes are already decoded and size-checked
 * by computerd, so the sandbox never sees base64.
 */
export type ClipboardPaste =
  | { kind: 'image'; mimeType: 'image/png' | 'image/jpeg'; bytes: Uint8Array }
  | { kind: 'files'; files: Array<{ name: string; bytes: Uint8Array }> };

/** Where the computer put it: an image path (its clipboard now holds it) or the saved files, relative to the agent's home. */
export type ClipboardPasteResult =
  | { kind: 'image'; path: string }
  | { kind: 'files'; saved: Array<{ name: string; path: string }> };

/** What the computer's clipboard held; `tooLarge` when it is over the caller's `maxBytes` (computerd answers 413). */
export type ClipboardCopyResult =
  | { kind: 'empty' }
  | { kind: 'text'; text: string }
  | { kind: 'image'; bytes: Uint8Array }
  | { kind: 'file'; name: string; bytes: Uint8Array }
  | { kind: 'tooLarge'; sizeBytes: number };

/** Only the field a given action produces is present. */
export type ScreenActionResult = {
  screenshot?: Screenshot;
  navigate?: NavigateResult;
  browser?: BrowserResult;
  meet?: MeetResult;
  shell?: ShellOutput;
  fileRead?: FileContent;
  fileWrite?: FileWriteResult;
  process?: ProcessResult;
  clipboardPaste?: ClipboardPasteResult;
  clipboardCopy?: ClipboardCopyResult;
};

export interface Resolution {
  width: number;
  height: number;
}

/** Live resource sample from inside the VM (used for the computer projection; never invented). */
export interface ComputerMetrics {
  memUsedMb: number;
  memTotalMb: number;
  vcpu: number;
  cpuPercent: number;
  diskUsedGb: number;
  diskTotalGb: number;
}

export function parseResolution(value: string): Resolution {
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!match) throw new Error(`invalid resolution: ${value}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

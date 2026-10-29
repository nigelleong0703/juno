/**
 * Agent-facing computer client seam.
 *
 * Package-owned pure interface: what agent tools call. The host supplies
 * an implementation. No provider types appear here beyond the
 * request/response shapes and the agent id each call acts for.
 */
import type { BrowserInput, BrowserResult } from './browser.js';
import type { MeetInput, MeetResult } from './meet.js';
import type { ComputerEnvironment } from './environment.js';
import type { HomeComputer } from './home.js';
import type {
  ComputerCopyInput,
  ComputerCopyResult,
  ComputerMetrics,
  ComputerTarget,
  InstallPackagesInput,
  InstallPackagesResult,
  MacDesktopAction,
  MacDesktopResult,
  FileContent,
  FileWriteRequest,
  FileWriteResult,
  NavigateResult,
  Point,
  ProcessOutput,
  ProcessReadInput,
  ProcessSnapshot,
  ProcessStartInput,
  ProcessStopInput,
  ProcessStopResult,
  ProcessWriteInput,
  ProcessWriteResult,
  RecordAudioInput,
  RecordAudioResult,
  Screenshot,
  SpaceRegisterInput,
  SpaceRegisterResult,
  ScrollInput,
  ShellInput,
  ShellOutput,
} from './types.js';

export interface ComputerClient {
  screenshot(agentId: string, signal: AbortSignal, on?: ComputerTarget): Promise<Screenshot>;
  click(agentId: string, input: Point, signal: AbortSignal, on?: ComputerTarget): Promise<void>;
  /** Optional pointer variants; a client that omits them falls back to `click`. */
  doubleClick?(agentId: string, input: Point, signal: AbortSignal, on?: ComputerTarget): Promise<void>;
  rightClick?(agentId: string, input: Point, signal: AbortSignal, on?: ComputerTarget): Promise<void>;
  move?(agentId: string, input: Point, signal: AbortSignal, on?: ComputerTarget): Promise<void>;
  type(agentId: string, text: string, signal: AbortSignal, on?: ComputerTarget): Promise<void>;
  pressKey(agentId: string, key: string, signal: AbortSignal, on?: ComputerTarget): Promise<void>;
  scroll(agentId: string, input: ScrollInput, signal: AbortSignal, on?: ComputerTarget): Promise<void>;
  navigate(agentId: string, url: string, signal: AbortSignal, on?: ComputerTarget): Promise<NavigateResult>;
  /**
   * Optional typed DOM action on the agent's own Chromium. A client that
   * omits it reports the browser tools unavailable; tools never fake it.
   */
  browser?(agentId: string, input: BrowserInput, signal: AbortSignal, on?: ComputerTarget): Promise<BrowserResult>;
  /** Optional Google Meet attendance through the sandbox helper (join, state, chat, leave); absent = no Meet support. */
  meet?(agentId: string, input: MeetInput, signal: AbortSignal): Promise<MeetResult>;
  /** Optional system-audio recording. Audio stays on the computer; a missing method is reported as unavailable. */
  recordAudio?(agentId: string, input: RecordAudioInput, signal: AbortSignal, on?: ComputerTarget): Promise<RecordAudioResult>;
  /** Optional: work an app on the owner's Mac through cua-driver (snapshot / act / verify). Always the Mac; absent = unavailable. */
  macDesktop?(agentId: string, action: MacDesktopAction, input: Record<string, unknown>, signal: AbortSignal): Promise<MacDesktopResult>;
  /** Optional Mail, Calendar and Reminders on the owner's Mac (the desktop app runs them); plain-text result. */
  macApps?(agentId: string, input: { tool: string; args: Record<string, unknown> }, signal: AbortSignal): Promise<string>;
  /** Optional: whether the owner of this agent has a Mac paired and its link up right now. */
  macStatus?(agentId: string, signal: AbortSignal): Promise<{ paired: boolean; online: boolean }>;
  runShell(agentId: string, input: ShellInput, signal: AbortSignal, on?: ComputerTarget): Promise<ShellOutput>;
  readFile(agentId: string, path: string, signal: AbortSignal, on?: ComputerTarget): Promise<FileContent>;
  writeFile(agentId: string, input: FileWriteRequest, signal: AbortSignal, on?: ComputerTarget): Promise<FileWriteResult>;
  /**
   * Optional async process control. A client that omits these reports the
   * process tools unavailable; tools never simulate a process locally.
   */
  startProcess?(agentId: string, input: ProcessStartInput, signal: AbortSignal, on?: ComputerTarget): Promise<ProcessSnapshot>;
  readProcess?(agentId: string, input: ProcessReadInput, signal: AbortSignal, on?: ComputerTarget): Promise<ProcessOutput>;
  writeProcess?(agentId: string, input: ProcessWriteInput, signal: AbortSignal, on?: ComputerTarget): Promise<ProcessWriteResult>;
  stopProcess?(agentId: string, input: ProcessStopInput, signal: AbortSignal, on?: ComputerTarget): Promise<ProcessStopResult>;
  /** Trusted Jev MCP stdio (fixed supervisor entrypoint via root runtime, own display CDP only). No command args. */
  startJevMcp?(agentId: string, signal: AbortSignal, on?: ComputerTarget): Promise<ProcessSnapshot>;
  readJevMcp?(agentId: string, input: ProcessReadInput, signal: AbortSignal, on?: ComputerTarget): Promise<ProcessOutput>;
  writeJevMcp?(agentId: string, input: ProcessWriteInput, signal: AbortSignal, on?: ComputerTarget): Promise<ProcessWriteResult>;
  stopJevMcp?(agentId: string, input: ProcessStopInput, signal: AbortSignal, on?: ComputerTarget): Promise<ProcessStopResult>;
  /** Optional system package install (apt-get as root, BACKEND §7.9); the tool always asks the user first. */
  installPackages?(agentId: string, input: InstallPackagesInput, signal: AbortSignal): Promise<InstallPackagesResult>;
  /** Optional Spaces (BACKEND 5.12): the app-range ports already listening in the computer. */
  spacePorts?(agentId: string, signal: AbortSignal): Promise<number[]>;
  /** Optional Spaces: have the platform verify the listener and wire the gateway route. Rejects with the reason the agent should act on. */
  registerSpace?(agentId: string, input: SpaceRegisterInput, signal: AbortSignal): Promise<SpaceRegisterResult>;
  /**
   * Read-only view of the bound computer (working directory, user, home,
   * platform). Used for run context and relative paths; never allocates.
   */
  environment(agentId: string, signal: AbortSignal, on?: ComputerTarget): Promise<ComputerEnvironment>;
  /** Optional: copy a file or folder between the agent's sandbox and the owner's Mac (computerd moves the bytes). */
  copy?(agentId: string, input: ComputerCopyInput, signal: AbortSignal): Promise<ComputerCopyResult>;
  /** Optional: start this agent's screen (its user and display) if it has none yet; the explicit first-use allocation. */
  ensureScreen?(agentId: string, signal: AbortSignal): Promise<void>;
  /** Optional: the user's `/juno` home (identity, memory, skills files). A client without it leaves those context sections to the mirror. */
  home?: HomeComputer;
  /** Optional: the owner-visible view of the shared VM (no secrets). */
  computer?(signal: AbortSignal): Promise<{
    sandboxId: string;
    template: string;
    metrics: ComputerMetrics | null;
  }>;
}

/** Late-bound lookup: the host returns `undefined` when no sandbox is configured. */
export type ComputerClientProvider = () => ComputerClient | undefined;

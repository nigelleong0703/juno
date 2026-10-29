/**
 * The agent-facing sandbox client seam. This is what the agent tools call; the runner supplies an
 * implementation (an HTTP adapter to computerd) and computerd itself implements nothing here.
 *
 * No provider types appear in this file: a caller of \`screenshot\`/\`click\`/\`runShell\` only needs the
 * request/response shapes and the agent id it acts for. That keeps the dependency direction
 * \`tools → computer\` (never the reverse) and lets the runner swap transports (HTTP now, a future
 * in-process or bridge transport) without touching the tools.
 */
import type { ComputerEnvironment } from './environment.js';
import type { BrowserInput, BrowserResult } from './browser.js';
import type {
  ComputerMetrics,
  FileContent,
  FileWriteRequest,
  FileWriteResult,
  NavigateResult,
  Point,
  ProcessOutput,
  ProcessReadInput,
  ProcessSnapshot,
  ProcessStopInput,
  ProcessStartInput,
  ProcessStopResult,
  ProcessWriteInput,
  ProcessWriteResult,
  Screenshot,
  ScrollInput,
  ShellInput,
  ShellOutput,
} from './types.js';

export interface ComputerClient {
  screenshot(agentId: string, signal: AbortSignal): Promise<Screenshot>;
  click(agentId: string, input: Point, signal: AbortSignal): Promise<void>;
  /** Optional pointer variants; a client that omits them falls back to \`click\`. */
  doubleClick?(agentId: string, input: Point, signal: AbortSignal): Promise<void>;
  rightClick?(agentId: string, input: Point, signal: AbortSignal): Promise<void>;
  move?(agentId: string, input: Point, signal: AbortSignal): Promise<void>;
  type(agentId: string, text: string, signal: AbortSignal): Promise<void>;
  pressKey(agentId: string, key: string, signal: AbortSignal): Promise<void>;
  scroll(agentId: string, input: ScrollInput, signal: AbortSignal): Promise<void>;
  navigate(agentId: string, url: string, signal: AbortSignal): Promise<NavigateResult>;
  /**
   * Optional typed DOM action on the agent's own Chromium via the sandbox-local browser
   * helper. A client that omits it reports the browser tools unavailable; tools never fake it.
   */
  browser?(agentId: string, input: BrowserInput, signal: AbortSignal): Promise<BrowserResult>;
  runShell(agentId: string, input: ShellInput, signal: AbortSignal): Promise<ShellOutput>;
  readFile(agentId: string, path: string, signal: AbortSignal): Promise<FileContent>;
  writeFile(agentId: string, input: FileWriteRequest, signal: AbortSignal): Promise<FileWriteResult>;
  /**
   * Optional async process control. A client that omits these reports the process tools
   * unavailable; the tools never simulate a background process locally.
   */
  startProcess?(agentId: string, input: ProcessStartInput, signal: AbortSignal): Promise<ProcessSnapshot>;
  readProcess?(agentId: string, input: ProcessReadInput, signal: AbortSignal): Promise<ProcessOutput>;
  writeProcess?(agentId: string, input: ProcessWriteInput, signal: AbortSignal): Promise<ProcessWriteResult>;
  stopProcess?(agentId: string, input: ProcessStopInput, signal: AbortSignal): Promise<ProcessStopResult>;
  /** Trusted Jev MCP stdio (fixed supervisor entrypoint via root runtime, own display CDP only). No command args. */
  startJevMcp?(agentId: string, signal: AbortSignal): Promise<ProcessSnapshot>;
  readJevMcp?(agentId: string, input: ProcessReadInput, signal: AbortSignal): Promise<ProcessOutput>;
  writeJevMcp?(agentId: string, input: ProcessWriteInput, signal: AbortSignal): Promise<ProcessWriteResult>;
  stopJevMcp?(agentId: string, input: ProcessStopInput, signal: AbortSignal): Promise<ProcessStopResult>;
  /** Optional system package install (apt-get as root, BACKEND §7.9). */
  installPackages?(agentId: string, input: { packages: string[]; reason: string }, signal: AbortSignal): Promise<{ output: string }>;
  /**
   * Read-only view of the bound computer (working directory, user, home, platform). Used for
   * run context and for resolving relative paths; never allocates or starts anything.
   */
  environment(agentId: string, signal: AbortSignal): Promise<ComputerEnvironment>;
  /** Optional: the owner-visible view of the shared VM (no secrets). */
  computer?(signal: AbortSignal): Promise<{ sandboxId: string; template: string; metrics: ComputerMetrics | null }>;
}

/** Late-bound lookup: the runner returns \`undefined\` when no sandbox is configured. */
export type ComputerClientProvider = () => ComputerClient | undefined;

/**
 * The qualified sandbox stdio bridge for MCP. An owner-configured stdio server runs inside the
 * agent's bound computer through the async process seam (start/read/write/stop) — the host never
 * spawns it. Framing is newline-delimited JSON-RPC on stdout ONLY: stderr is captured separately and
 * handed to a diagnostic sink, so a server's log lines can never be parsed as protocol frames.
 */
import type { ComputerClient } from '../computer/contract.js';
import { ComputerError } from '../computer/contract.js';
import type { SandboxStdioBridge, SandboxStdioChannel } from '../../mcp/index.js';
import { shellQuote } from './codingHelpers.js';

export interface SandboxStdioBridgeOptions {
  client: ComputerClient;
  /** The agent whose computer runs the server (every process call is scoped to it). */
  agentId: string;
  cwd?: string;
  pollMs?: number;
  onStderr?: (text: string) => void;
  /** Called once the server process is gone (so a caller can fail pending requests instead of hanging). */
  onExit?: () => void;
}

export interface SandboxStdioOpenInput {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** The channel plus the bound process handle it owns (so a caller can confirm it was stopped). */
export interface BoundStdioChannel extends SandboxStdioChannel {
  readonly handle: string;
}

export type BoundStdioBridge = Omit<SandboxStdioBridge, 'open'> & {
  open(input: SandboxStdioOpenInput): Promise<BoundStdioChannel>;
};

const DEFAULT_POLL_MS = 25;
const MAX_FRAME_BYTES = 60_000;

export function createSandboxStdioBridge(options: SandboxStdioBridgeOptions): BoundStdioBridge {
  return {
    async open(input: SandboxStdioOpenInput): Promise<BoundStdioChannel> {
      const client = options.client;
      const start = client.startProcess?.bind(client);
      if (!start) {
        throw new ComputerError('unavailable', 'MCP stdio requires a sandbox client with async process control; the host does not spawn MCP servers');
      }
      const snapshot = await start(options.agentId, { command: commandLine(input), ...(options.cwd === undefined ? {} : { cwd: options.cwd }) }, new AbortController().signal);
      return new SandboxStdioChannelImpl(options, snapshot.handle);
    },
  };
}

/**
 * One shell word per argument (single-quoted, so no argument can be re-interpreted), with the server's
 * env passed through `env` inside the sandbox. Values travel only inside the agent's own computer.
 */
function commandLine(input: SandboxStdioOpenInput): string {
  const words = [input.command, ...input.args].map(shellQuote);
  const env = Object.entries(input.env ?? {}).map(([key, value]) => key + '=' + shellQuote(value));
  return env.length === 0 ? words.join(' ') : ['env', ...env, ...words].join(' ');
}

class SandboxStdioChannelImpl implements BoundStdioChannel {
  private readonly client: ComputerClient;
  private readonly options: SandboxStdioBridgeOptions;
  readonly handle: string;
  private cursor = 0;
  private stderrCursor = 0;
  private buffer = '';
  private handler: ((line: string) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private writes: Promise<void> = Promise.resolve();
  private polling = false;
  private closed = false;

  constructor(options: SandboxStdioBridgeOptions, handle: string) {
    this.options = options;
    this.client = options.client;
    this.handle = handle;
    this.timer = setInterval(() => void this.poll(), options.pollMs ?? DEFAULT_POLL_MS);
    this.timer.unref?.();
  }

  send(line: string): void {
    if (this.closed) return;
    if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) throw new ComputerError('failed', 'MCP frame exceeds the sandbox stdin limit');
    const write = this.client.writeProcess?.bind(this.client);
    if (!write) return;
    // Keep frames in order: each write waits for the previous one.
    this.writes = this.writes.then(() => write(this.options.agentId, { handle: this.handle, data: line + '\n' }, new AbortController().signal)).then(() => undefined, () => undefined);
  }

  onMessage(handler: (line: string) => void): void {
    this.handler = handler;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    const stop = this.client.stopProcess?.bind(this.client);
    if (stop) await stop(this.options.agentId, { handle: this.handle }, new AbortController().signal).catch(() => undefined);
  }

  private async poll(): Promise<void> {
    if (this.closed || this.polling) return;
    const read = this.client.readProcess?.bind(this.client);
    if (!read) return;
    this.polling = true;
    try {
      const output = await read(this.options.agentId, { handle: this.handle, cursor: this.cursor, stderrCursor: this.stderrCursor }, new AbortController().signal);
      this.cursor = output.cursor;
      this.stderrCursor = output.stderrCursor;
      if (output.stderr !== '') this.options.onStderr?.(output.stderr);
      this.deliver(output.output);
      if (output.state !== 'running') this.finish();
    } catch {
      this.finish();
    } finally {
      this.polling = false;
    }
  }

  /** Split stdout into complete newline-delimited frames; a partial tail waits for the next poll. */
  private deliver(chunk: string): void {
    if (chunk === '') return;
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) break;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line !== '') this.handler?.(line);
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.options.onExit?.();
  }
}

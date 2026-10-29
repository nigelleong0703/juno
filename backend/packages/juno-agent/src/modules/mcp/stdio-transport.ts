// Stdio MCP transport. The host never spawns a process: the owner-configured command runs only
// through a qualified sandbox bridge supplied by computerd, so stdio stays inside the agent's
// bound computer. Without that bridge stdio is refused instead of falling back to a host spawn.
import { McpProtocolError, buildNotification, buildRequest, parseFrame, subscriptionParams } from './protocol.js';
import type { McpListenOptions, McpNotificationHandler, McpTransport } from './transport.js';

/** Resolves once `signal` aborts (immediately when it already has). */
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

export interface SandboxStdioChannel {
  send(line: string): void;
  onMessage(handler: (line: string) => void): void;
  /** Optional: called once the server process is gone, so pending calls fail promptly. */
  onExit?(handler: () => void): void;
  close(): Promise<void>;
}

export interface SandboxStdioBridge {
  open(options: { command: string; args: string[]; env?: Record<string, string> }): Promise<SandboxStdioChannel>;
}

export interface StdioTransportOptions {
  bridge: SandboxStdioBridge;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class StdioMcpTransport implements McpTransport {
  readonly kind = 'stdio';
  private readonly options: StdioTransportOptions;
  private channel: SandboxStdioChannel | undefined;
  private readonly pending = new Map<string, PendingCall>();
  /** Notification handlers attached by listen(); a notification reaches every one of them. */
  private readonly listeners = new Set<McpNotificationHandler>();
  private closed = false;

  constructor(options: StdioTransportOptions) {
    this.options = options;
  }

  async request(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const signal = options.signal;
    // A cancelled call must never open the bridge or reach the server.
    if (signal?.aborted) throw new McpProtocolError(-32800, 'MCP stdio request was cancelled before start');
    const channel = await this.ensure();
    if (signal?.aborted) throw new McpProtocolError(-32800, 'MCP stdio request was cancelled before send');
    const key = String(id);
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
    });
    const rejectCall = () => {
      const entry = this.pending.get(key);
      if (entry === undefined) return;
      this.pending.delete(key);
      entry.reject(new McpProtocolError(-32800, 'MCP stdio request was cancelled'));
    };
    const onAbort = () => rejectCall();
    if (signal !== undefined) {
      if (signal.aborted) rejectCall();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    channel.send(buildRequest(id, method, params));
    try {
      return await promise;
    } finally {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
    }
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.closed) return;
    const channel = await this.ensure();
    channel.send(buildNotification(method, params));
  }

  /**
   * Modern: a subscriptions/listen request whose notifications arrive on this channel until it is cancelled
   * (a notifications/cancelled is sent on abort). Legacy (no filter): unsolicited notifications already arrive
   * on the channel, so this only attaches a handler until the caller stops.
   */
  async listen(options: McpListenOptions, onNotification: McpNotificationHandler, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const channel = await this.ensure();
    this.listeners.add(onNotification);
    try {
      if (options.subscribe === undefined) {
        await untilAborted(signal);
        return true;
      }
      const key = String(options.id);
      const ended = new Promise<void>((resolve) => {
        this.pending.set(key, { resolve: () => resolve(), reject: () => resolve() });
      });
      channel.send(buildRequest(options.id, 'subscriptions/listen', subscriptionParams(options.subscribe)));
      await Promise.race([ended, untilAborted(signal)]);
      if (signal.aborted && this.pending.delete(key)) {
        channel.send(buildNotification('notifications/cancelled', { requestId: options.id, reason: 'client-abort' }));
      }
      return true;
    } finally {
      this.listeners.delete(onNotification);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.pending.values()) entry.reject(new McpProtocolError(-32800, 'MCP stdio session closed'));
    this.pending.clear();
    await this.channel?.close();
    this.channel = undefined;
  }

  private async ensure(): Promise<SandboxStdioChannel> {
    if (this.closed) throw new McpProtocolError(-32000, 'MCP transport is closed');
    if (this.channel !== undefined) return this.channel;
    const options = this.options.env === undefined
      ? { command: this.options.command, args: this.options.args }
      : { command: this.options.command, args: this.options.args, env: this.options.env };
    const channel = await this.options.bridge.open(options);
    channel.onMessage((line) => this.handle(line));
    channel.onExit?.(() => this.failAll(new McpProtocolError(-32800, 'MCP stdio server exited')));
    this.channel = channel;
    return channel;
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  private handle(line: string): void {
    let frame;
    try {
      frame = parseFrame(line);
    } catch {
      return;
    }
    if (frame.id === undefined) {
      if (frame.method !== undefined) for (const handler of this.listeners) handler(frame.method, frame.params ?? {});
      return;
    }
    const entry = this.pending.get(String(frame.id));
    if (entry === undefined) return;
    this.pending.delete(String(frame.id));
    if (frame.error !== undefined) entry.reject(new McpProtocolError(frame.error.code, frame.error.message));
    else entry.resolve(frame.result);
  }
}

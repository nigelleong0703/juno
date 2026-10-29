// Private native relay over the qualified stdio channel. Only the canonical managed command is
// handled here; every other command remains the ordinary sandbox stdio path.
import type { ComputerClient } from '../tools/computer/contract.js';
import { ComputerError } from '../tools/computer/contract.js';
import { createSandboxStdioBridge } from '../tools/tools/mcpStdio.js';
import type { SandboxStdioBridge, SandboxStdioChannel } from './stdio-transport.js';

export const JEV_RELAY_METHOD = 'juno/jev';
const MAX_RELAY_CHARS = 1024 * 1024;

export interface JevRelayBridgeOptions {
  client: ComputerClient;
  agentId: string;
  jevCommand: string;
  jevWrapper: string;
  relay: (params: unknown, signal: AbortSignal) => Promise<{ status: number; body: unknown }>;
  activeSignal?: () => AbortSignal | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idOf(frame: Record<string, unknown>): string | number | undefined {
  const id = frame['id'];
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

function paramsSize(params: unknown): number {
  try {
    const encoded = JSON.stringify(params);
    return typeof encoded === 'string' ? Buffer.byteLength(encoded, 'utf8') : MAX_RELAY_CHARS + 1;
  } catch {
    return MAX_RELAY_CHARS + 1;
  }
}

function qualifiedClient(client: ComputerClient): ComputerClient {
  const start = client.startJevMcp;
  const read = client.readJevMcp;
  const write = client.writeJevMcp;
  const stop = client.stopJevMcp;
  if (start === undefined || read === undefined || write === undefined || stop === undefined) {
    throw new ComputerError('unavailable', 'trusted Jev MCP process control is unavailable on this computer');
  }
  return {
    ...client,
    startProcess: (agentId, _input, signal) => start.call(client, agentId, signal),
    readProcess: (agentId, input, signal) => read.call(client, agentId, input, signal),
    writeProcess: (agentId, input, signal) => write.call(client, agentId, input, signal),
    stopProcess: (agentId, input, signal) => stop.call(client, agentId, input, signal),
  };
}

function isManaged(input: { command: string; args: string[] }, options: JevRelayBridgeOptions): boolean {
  return input.command === options.jevCommand && input.args.length === 1 && input.args[0] === options.jevWrapper;
}

export function createJevRelayBridge(options: JevRelayBridgeOptions): SandboxStdioBridge {
  return {
    async open(input): Promise<SandboxStdioChannel> {
      if (!isManaged(input, options)) {
        return createSandboxStdioBridge({ client: options.client, agentId: options.agentId }).open(input);
      }

      const lifetime = new AbortController();
      const relaySignal = options.activeSignal ?? (() => undefined);
      const exitHandlers = new Set<() => void>();
      const calls = new Map<string | number, { signal: AbortSignal; onAbort: () => void }>();
      let handler: ((line: string) => void) | undefined;
      let closed = false;

      const releaseCalls = (): void => {
        for (const { signal, onAbort } of calls.values()) signal.removeEventListener('abort', onAbort);
        calls.clear();
      };

      const finish = (): void => {
        if (closed) return;
        closed = true;
        lifetime.abort();
        releaseCalls();
        for (const onExit of exitHandlers) onExit();
        exitHandlers.clear();
      };

      const tieCall = (id: string | number, signal: AbortSignal): boolean => {
        if (signal.aborted) {
          finish();
          return false;
        }
        const onAbort = () => {
          finish();
        };
        calls.set(id, { signal, onAbort });
        signal.addEventListener('abort', onAbort, { once: true });
        return true;
      };

      const releaseReply = (frame: unknown): void => {
        if (!isRecord(frame) || frame['method'] !== undefined) return;
        const id = idOf(frame);
        if (id === undefined) return;
        const call = calls.get(id);
        if (call === undefined) return;
        call.signal.removeEventListener('abort', call.onAbort);
        calls.delete(id);
      };

      const sendRejected = (id: string | number, error: unknown): void => {
        if (closed || lifetime.signal.aborted) return;
        const message = error instanceof Error ? error.message : 'relay failed';
        raw?.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: message.slice(0, 500) } }));
      };

      const handleFrame = async (line: string): Promise<void> => {
        let frame: unknown;
        try {
          frame = JSON.parse(line);
        } catch {
          handler?.(line);
          return;
        }
        releaseReply(frame);
        if (!isRecord(frame) || frame['method'] !== JEV_RELAY_METHOD) {
          handler?.(line);
          return;
        }
        const id = idOf(frame);
        if (id === undefined) return;
        const params = frame['params'];
        try {
          if (paramsSize(params) > MAX_RELAY_CHARS) throw new Error('relay frame too large');
          const call = relaySignal();
          const signal = call === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, call]);
          if (signal.aborted) return;
          const result = await options.relay(params, signal);
          if (!closed && !lifetime.signal.aborted) {
            raw?.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
          }
        } catch (error) {
          sendRejected(id, error);
        }
      };

      const bridge = createSandboxStdioBridge({
        client: qualifiedClient(options.client),
        agentId: options.agentId,
        onExit: finish,
      });
      const raw = await bridge.open(input);
      raw.onMessage((line) => {
        void handleFrame(line);
      });
      lifetime.signal.addEventListener('abort', () => {
        void raw?.close().catch(() => undefined);
      }, { once: true });

      return {
        send(line: string): void {
          if (closed) return;
          let frame: unknown;
          try {
            frame = JSON.parse(line);
          } catch {
            raw?.send(line);
            return;
          }
          const request = isRecord(frame) && frame['method'] === 'tools/call';
          const id = isRecord(frame) ? idOf(frame) : undefined;
          const signal = request && id !== undefined ? relaySignal() : undefined;
          if (request && id !== undefined && signal !== undefined && !tieCall(id, signal)) return;
          raw?.send(line);
        },
        onMessage(next: (line: string) => void): void {
          handler = next;
        },
        onExit(next: () => void): void {
          if (closed) next();
          else exitHandlers.add(next);
        },
        async close(): Promise<void> {
          lifetime.abort();
          await raw?.close().catch(() => undefined);
          finish();
        },
      };
    },
  };
}

import { describe, expect, it, vi } from 'vitest';
import type {
  ComputerClient,
  ProcessOutput,
  ProcessReadInput,
  ProcessSnapshot,
  ProcessState,
  ProcessStopResult,
  ProcessWriteResult,
} from '../../tools/index.js';
import { createJevRelayBridge } from '../jev-relay-bridge.js';

const COMMAND = '/usr/bin/python3';
const WRAPPER = '/opt/juno/jev-browser/agent_jev_supervise.py';

interface Fake {
  client: ComputerClient;
  counters: { trustedStart: number; normalStart: number; trustedWrite: number; trustedStop: number };
  processes: Map<string, { output: string; state: ProcessState }>;
}

function fake(withTrusted: boolean, emitRelay = false): Fake {
  const processes = new Map<string, { output: string; state: ProcessState }>();
  const counters = { trustedStart: 0, normalStart: 0, trustedWrite: 0, trustedStop: 0 };
  const start = (): ProcessSnapshot => {
    const id = processes.size + 1;
    const handle = 'p_' + String(id).padStart(12, '0');
    processes.set(handle, { output: '', state: 'running' });
    return { handle, pid: id, state: 'running', exitCode: null, startedAt: '' };
  };
  const read = (input: ProcessReadInput): ProcessOutput => {
    const proc = processes.get(input.handle);
    if (proc === undefined) throw new Error('unknown process');
    const cursor = input.cursor ?? 0;
    return {
      handle: input.handle, state: proc.state, exitCode: null, output: proc.output.slice(cursor), stderr: '',
      cursor: proc.output.length, stderrCursor: 0, totalBytes: proc.output.length, stderrTotalBytes: 0,
      truncated: false, stderrTruncated: false,
    };
  };
  const write = (input: { handle: string; data: string }, trusted: boolean): ProcessWriteResult => {
    const proc = processes.get(input.handle);
    if (proc === undefined) throw new Error('unknown process');
    if (trusted) {
      counters.trustedWrite += 1;
      const frame: unknown = JSON.parse(input.data);
      if (emitRelay && typeof frame === 'object' && frame !== null && Reflect.get(frame, 'method') === 'tools/call') {
        const id = Reflect.get(frame, 'id');
        proc.output += JSON.stringify({ jsonrpc: '2.0', id, method: 'juno/jev', params: { state: '{"pin":"5"}', questions: { ok: {} } } }) + '\n';
      }
    }
    return { handle: input.handle, bytes: Buffer.byteLength(input.data) };
  };
  const stop = (handle: string, trusted: boolean): ProcessStopResult => {
    const proc = processes.get(handle);
    if (proc === undefined) throw new Error('unknown process');
    if (trusted) counters.trustedStop += 1;
    proc.state = 'stopped';
    return { handle, state: 'stopped', exitCode: 0 };
  };
  const client: ComputerClient = {
    async screenshot() { return { data: '', mimeType: 'image/png', width: 0, height: 0, displayNo: 0 }; },
    async click() {},
    async type() {},
    async pressKey() {},
    async scroll() {},
    async navigate(_agent, url) { return { url }; },
    async runShell() { return { stdout: '', stderr: '', exitCode: 0 }; },
    async readFile() { return { content: '', bytes: 0 }; },
    async writeFile() { return { path: '', bytes: 0 }; },
    async environment() { return { os: 'linux', platform: 'linux', user: 'agent', home: '/home/agent', workingDirectory: '/tmp', pathStyle: 'posix', kind: 'sandbox' }; },
    async startProcess() { counters.normalStart += 1; return start(); },
    async readProcess(_agent, input) { return read(input); },
    async writeProcess(_agent, input) { return write(input, false); },
    async stopProcess(_agent, input) { return stop(input.handle, false); },
    ...(withTrusted ? {
      async startJevMcp() { counters.trustedStart += 1; return start(); },
      async readJevMcp(_agent: string, input: ProcessReadInput) { return read(input); },
      async writeJevMcp(_agent: string, input: { handle: string; data: string }) { return write(input, true); },
      async stopJevMcp(_agent: string, input: { handle: string }) { return stop(input.handle, true); },
    } : {}),
  };
  return { client, counters, processes };
}

const managed = { command: COMMAND, args: [WRAPPER] };

describe('private Jev relay bridge', () => {
  it('leaves non-matching stdio on the ordinary process port', async () => {
    const found = fake(false);
    const bridge = createJevRelayBridge({
      client: found.client, agentId: 'agent-a', jevCommand: COMMAND, jevWrapper: WRAPPER,
      relay: async () => ({ status: 200, body: {} }),
    });
    await bridge.open({ command: '/bin/ordinary-mcp', args: [] });
    expect(found.counters.normalStart).toBe(1);
    expect(found.counters.trustedStart).toBe(0);
  });

  it('refuses the managed command explicitly when trusted process methods are absent', async () => {
    const bridge = createJevRelayBridge({
      client: fake(false).client, agentId: 'agent-a', jevCommand: COMMAND, jevWrapper: WRAPPER,
      relay: async () => ({ status: 200, body: {} }),
    });
    await expect(bridge.open(managed)).rejects.toThrow(/trusted Jev MCP process control is unavailable/);
  });

  it('does not send a tools/call when its active signal is already aborted', async () => {
    const found = fake(true);
    const controller = new AbortController();
    controller.abort();
    const onExit = vi.fn();
    const bridge = createJevRelayBridge({
      client: found.client, agentId: 'agent-a', jevCommand: COMMAND, jevWrapper: WRAPPER,
      relay: async () => ({ status: 200, body: {} }), activeSignal: () => controller.signal,
    });
    const channel = await bridge.open(managed);
    channel.onExit?.(onExit);
    channel.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_do' } }));
    expect(onExit).toHaveBeenCalledOnce();
    expect(found.counters.trustedWrite).toBe(0);
    await vi.waitFor(() => expect(found.counters.trustedStop).toBe(1));
  });

  it('closes the original process when cancellation lands between the call and its native relay', async () => {
    const found = fake(true);
    const controller = new AbortController();
    const onExit = vi.fn();
    const relay = vi.fn(async () => ({ status: 200, body: {} }));
    const bridge = createJevRelayBridge({
      client: found.client, agentId: 'agent-a', jevCommand: COMMAND, jevWrapper: WRAPPER,
      relay, activeSignal: () => controller.signal,
    });
    const channel = await bridge.open(managed);
    channel.onExit?.(onExit);
    channel.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_do' } }));
    await vi.waitFor(() => expect(found.counters.trustedWrite).toBe(1));
    controller.abort();
    expect(onExit).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(found.counters.trustedStop).toBe(1));
    expect(relay).not.toHaveBeenCalled();
  });

  it('aborts an in-flight native relay and stops the original process', async () => {
    const found = fake(true, true);
    const controller = new AbortController();
    let relaySignal: AbortSignal | undefined;
    const bridge = createJevRelayBridge({
      client: found.client, agentId: 'agent-a', jevCommand: COMMAND, jevWrapper: WRAPPER,
      relay: async (_params, signal) => {
        relaySignal = signal;
        return await new Promise(() => undefined);
      },
      activeSignal: () => controller.signal,
    });
    const channel = await bridge.open(managed);
    const onExit = vi.fn();
    channel.onExit?.(onExit);
    channel.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_do' } }));
    await vi.waitFor(() => expect(relaySignal).toBeDefined());
    controller.abort();
    expect(relaySignal?.aborted).toBe(true);
    expect(onExit).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(found.counters.trustedStop).toBe(1));
  });

  it('removes the call abort listener after its RPC reply', async () => {
    const found = fake(true);
    const controller = new AbortController();
    const onExit = vi.fn();
    const bridge = createJevRelayBridge({
      client: found.client, agentId: 'agent-a', jevCommand: COMMAND, jevWrapper: WRAPPER,
      relay: async () => ({ status: 200, body: {} }), activeSignal: () => controller.signal,
    });
    const channel = await bridge.open(managed);
    channel.onExit?.(onExit);
    const messages = vi.fn();
    channel.onMessage(messages);
    const handle = [...found.processes.keys()][0];
    if (handle === undefined) throw new Error('trusted process did not start');
    channel.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_do' } }));
    await vi.waitFor(() => expect(found.counters.trustedWrite).toBe(1));
    const proc = found.processes.get(handle);
    if (proc === undefined) throw new Error('trusted process disappeared');
    proc.output += JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }) + '\n';
    await vi.waitFor(() => expect(messages).toHaveBeenCalled());
    controller.abort();
    expect(onExit).not.toHaveBeenCalled();
    expect(found.counters.trustedStop).toBe(0);
  });
});

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ComputerClient, ProcessOutput, ProcessReadInput, ProcessSnapshot, ProcessState, ProcessStopResult, ProcessWriteResult } from '../../modules/tools/index.js';
import type { Tool, ToolContext } from '../../contracts/index.js';
import { createMemoryStore } from '../../testing/store.js';
import { runWithOwner } from '../../owner-context.js';
import { createMcpManager } from '../../modules/mcp/index.js';
import { createMcpConnectionStore } from '../../modules/mcp/connections.js';
import { mcpAgent, mcpCtx } from '../../modules/tools/__tests__/mcpFixtures.js';
import { loadConfig } from '../config.js';
import { createJevGatedManager, createJevMcpRuntime, jevConnectionIdForOwner } from '../jev-browser-gate.js';
import { jevMcpServerConfig } from '../jev-browser-mcp.js';

const OWNER = 'owner-1';
const AGENT = 'agent-a';
process.env['SECRETS_KEY'] ??= randomBytes(32).toString('base64');

interface Process {
  kind: 'trusted' | 'normal';
  state: ProcessState;
  output: string;
}

interface FakeComputer {
  client: ComputerClient;
  processes: Map<string, Process>;
  counters: { trustedStarts: number; normalStarts: number; trustedWrites: number };
}

function fakeComputer(): FakeComputer {
  const processes = new Map<string, Process>();
  const counters = { trustedStarts: 0, normalStarts: 0, trustedWrites: 0 };
  const start = (kind: Process['kind']): ProcessSnapshot => {
    const id = processes.size + 1;
    const handle = 'p_' + String(id).padStart(12, '0');
    processes.set(handle, { kind, state: 'running', output: '' });
    return { handle, pid: id, state: 'running', exitCode: null, startedAt: '2026-10-21T00:00:00.000Z' };
  };
  const reply = (handle: string, input: ProcessReadInput): ProcessOutput => {
    const proc = processes.get(handle);
    if (proc === undefined) throw new Error('unknown handle');
    const cursor = input.cursor ?? 0;
    return {
      handle, state: proc.state, exitCode: null, output: proc.output.slice(cursor), stderr: '',
      cursor: proc.output.length, stderrCursor: 0, totalBytes: proc.output.length, stderrTotalBytes: 0,
      truncated: false, stderrTruncated: false,
    };
  };
  const write = (handle: string, data: string, trusted: boolean): ProcessWriteResult => {
    const proc = processes.get(handle);
    if (proc === undefined || proc.kind !== (trusted ? 'trusted' : 'normal')) throw new Error('wrong process namespace');
    if (trusted) counters.trustedWrites += 1;
    for (const line of data.trim().split('\n').filter(Boolean)) {
      const frame: unknown = JSON.parse(line);
      if (typeof frame !== 'object' || frame === null) continue;
      const method = Reflect.get(frame, 'method');
      const id = Reflect.get(frame, 'id');
      if (method === 'initialize') {
        proc.output += JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: proc.kind, version: '1' } } }) + '\n';
      } else if (method === 'server/discover') {
        // A legacy server answers the modern probe with method-not-found, which keeps the connect on initialize.
        proc.output += JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } }) + '\n';
      } else if (method === 'tools/list') {
        const tools = proc.kind === 'trusted'
          ? [
              { name: 'browser_do', description: 'original decision', inputSchema: { type: 'object', properties: { goal: { type: 'string' } } } },
              { name: 'browser_snapshot', description: 'original snapshot', inputSchema: { type: 'object', properties: {} } },
            ]
          : [{ name: 'echo', description: 'ordinary stdio', inputSchema: { type: 'object', properties: {} } }];
        proc.output += JSON.stringify({ jsonrpc: '2.0', id, result: { tools } }) + '\n';
      } else if (method === 'tools/call') {
        proc.output += JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: proc.kind + ':' + String(Reflect.get(Reflect.get(frame, 'params'), 'name')) }] } }) + '\n';
      }
    }
    return { handle, bytes: Buffer.byteLength(data) };
  };
  const stop = (handle: string): ProcessStopResult => {
    const proc = processes.get(handle);
    if (proc === undefined) throw new Error('unknown handle');
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
    async startProcess() { counters.normalStarts += 1; return start('normal'); },
    async readProcess(_agent, input) { return reply(input.handle, input); },
    async writeProcess(_agent, input) { return write(input.handle, input.data, false); },
    async stopProcess(_agent, input) { return stop(input.handle); },
    async startJevMcp() { counters.trustedStarts += 1; return start('trusted'); },
    async readJevMcp(_agent, input) { return reply(input.handle, input); },
    async writeJevMcp(_agent, input) { return write(input.handle, input.data, true); },
    async stopJevMcp(_agent, input) { return stop(input.handle); },
  };
  return { client, processes, counters };
}

async function setup(input: { flag?: string; native?: boolean; persisted?: boolean; ordinary?: boolean }) {
  const root = createMemoryStore();
  const store = root.forOwner?.(OWNER);
  if (store === undefined) throw new Error('store requires forOwner');
  await store.put('agents', mcpAgent(AGENT, []));
  const managedId = jevConnectionIdForOwner(OWNER);
  if (input.persisted === true) {
    await createMcpConnectionStore(store).save(OWNER, managedId, 'Jev Browser', jevMcpServerConfig(), { state: 'disconnected' });
  }
  if (input.ordinary === true) {
    await createMcpConnectionStore(store).save(OWNER, 'con-echo', 'Echo', { transport: 'stdio', command: '/bin/fake-echo', args: [] }, { state: 'disconnected' });
  }
  const config = loadConfig({
    JEV_BROWSER_MCP_ENABLED: input.flag ?? '0',
    ...(input.native === true ? { SYSTEM_ONE_BASE_URL: 'https://native.example', SYSTEM_ONE_API_KEY: 'native-secret', SYSTEM_ONE_MODEL_ID: 'jev-live' } : {}),
  });
  const computer = fakeComputer();
  const bridge = createJevMcpRuntime({ computer: computer.client, store: root, config }).stdioForAgent;
  const manager = createJevGatedManager(createMcpManager({ stdioForAgent: bridge }), root, config);
  return { root, store, managedId, config, computer, manager };
}

function browserTool(tools: Tool[]): Tool | undefined {
  return tools.find((tool) => tool.origin?.toolName === 'browser_do');
}

describe('Jev manager gate and cached-tool execution', () => {
  it('default-off hides a persisted row, preserves it, and leaves ordinary stdio working', async () => {
    const found = await setup({ flag: '0', native: true, persisted: true, ordinary: true });
    const tools = await runWithOwner(OWNER, () => found.manager.toolsForAgent({ ownerId: OWNER, store: found.store, agentId: AGENT }));
    expect(tools.map((tool) => tool.origin?.toolName)).toContain('echo');
    expect(browserTool(tools)).toBeUndefined();
    expect(found.computer.counters.trustedStarts).toBe(0);
    expect(found.computer.counters.normalStarts).toBeGreaterThan(0);
    expect(await found.store.get('connections', found.managedId)).not.toBeNull();
    await expect(found.manager.connect({ ownerId: OWNER, store: found.store, connectionId: found.managedId })).rejects.toThrow(/not available/);
    await expect(found.manager.listTools({ ownerId: OWNER, store: found.store, connectionId: found.managedId })).rejects.toThrow(/not available/);
    await expect(found.manager.callTool({ ownerId: OWNER, store: found.store, agentId: AGENT, connectionId: found.managedId, toolName: 'browser_do', args: {} })).rejects.toThrow(/not available/);
    expect(await found.manager.status({ ownerId: OWNER, store: found.store, connectionId: found.managedId })).toEqual({ state: 'disconnected' });
    expect(found.computer.counters.trustedStarts).toBe(0);
  });

  it('flag 1 without real native leaves persisted configuration inert', async () => {
    const found = await setup({ flag: '1', native: false, persisted: true, ordinary: true });
    const tools = await runWithOwner(OWNER, () => found.manager.toolsForAgent({ ownerId: OWNER, store: found.store, agentId: AGENT }));
    expect(browserTool(tools)).toBeUndefined();
    expect(tools.map((tool) => tool.origin?.toolName)).toContain('echo');
    expect(found.computer.counters.trustedStarts).toBe(0);
    expect(await found.store.get('connections', found.managedId)).not.toBeNull();
  });

  it('discovers the original tool on the trusted port and rejects its cached binding after native removal', async () => {
    const found = await setup({ flag: '1', native: true });
    const tools = await runWithOwner(OWNER, () => found.manager.toolsForAgent({ ownerId: OWNER, store: found.store, agentId: AGENT }));
    const tool = browserTool(tools);
    expect(tool).toBeDefined();
    expect(found.computer.counters.trustedStarts).toBeGreaterThan(0);
    const ctx = mcpCtx(found.store, AGENT);
    const outcome = await runWithOwner(OWNER, () => tool!.execute({ goal: 'read' }, ctx));
    expect(outcome.content[0]).toEqual({ type: 'text', text: 'trusted:browser_do' });

    Object.assign(found.config, { SYSTEM_ONE_API_KEY: '' });
    const writes = found.computer.counters.trustedWrites;
    await expect(runWithOwner(OWNER, () => tool!.execute({ goal: 'again' }, ctx))).rejects.toThrow(/disconnected, unconfigured, or removed/);
    expect(found.computer.counters.trustedWrites).toBe(writes);
  });

  it('allows revocation even while gated off, but refuses an owner-mismatched managed id', async () => {
    const found = await setup({ flag: '0', native: true, persisted: true });
    const revoked = await found.manager.disconnect({ ownerId: OWNER, store: found.store, connectionId: found.managedId });
    expect(revoked.enabled).toBe(false);
    const foreign = jevConnectionIdForOwner('owner-2');
    await expect(runWithOwner(OWNER, () => found.manager.disconnect({ ownerId: 'owner-2', store: found.store, connectionId: foreign }))).rejects.toThrow(/not available/);
    expect(await found.store.get('connections', foreign)).toBeNull();
  });

  it('rejects a cached Jev tool presented as another owner before touching the process', async () => {
    const found = await setup({ flag: '1', native: true });
    const tools = await runWithOwner(OWNER, () => found.manager.toolsForAgent({ ownerId: OWNER, store: found.store, agentId: AGENT }));
    const tool = browserTool(tools);
    expect(tool).toBeDefined();
    const writes = found.computer.counters.trustedWrites;
    const foreignCtx: ToolContext = { ...mcpCtx(found.store, AGENT), ownerId: 'owner-2' };
    await expect(tool!.execute({}, foreignCtx)).rejects.toThrow(/owner or connection changed/);
    expect(found.computer.counters.trustedWrites).toBe(writes);
  });
});

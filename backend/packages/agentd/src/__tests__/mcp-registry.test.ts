/** Regression evidence for the production MCP wiring and the bound sandbox stdio bridge: the REAL
 * execution tool assembly (createExecutionTools, which startExecution calls) against real HTTP and
 * sandbox stdio MCP servers, plus per-agent computers, cancellation and stderr separation. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store, ToolRegistry } from '@agent-desktop/contracts';
import type { ComputerClient } from '@agent-desktop/sandbox-adapters';
import { createExecutionTools, createMcpRuntime } from 'juno-agent/execution/mcp-runtime';
import { McpClient } from 'juno-agent/modules/mcp/client';
import { StdioMcpTransport } from 'juno-agent/modules/mcp/stdio-transport';
import { createToolRegistry } from 'juno-agent/modules/tools/index';
import { createSandboxStdioBridge } from 'juno-agent/modules/tools/tools/mcpStdio';
import { NoopEnqueuer } from 'juno-agent/modules/tools/__tests__/codingFixtures';
import { AgentScopedProcessClient, PosixProcessClient } from './shellProcessFixtures.js';
import { mcpAgent, mcpConnection, mcpCtx, mcpNames, scopedStore, startMcpHttpServer, writeMcpStdioServer, type McpHttpServer } from 'juno-agent/modules/tools/__tests__/mcpFixtures';

// Every manager a test opens is closed in teardown: an open stdio session is a live sandbox process.
const openedManagers: Array<ReturnType<typeof createMcpRuntime>> = [];

async function executionTools(store: Store, computer?: ComputerClient): Promise<ToolRegistry> {
  const mcp = createMcpRuntime(computer);
  openedManagers.push(mcp);
  return createExecutionTools({ store, enqueuer: new NoopEnqueuer(), mcp, ...(computer === undefined ? {} : { computer }) });
}

async function closeOpenedManagers(): Promise<void> {
  await Promise.all(openedManagers.splice(0).map((mcp) => mcp.close()));
}

afterEach(async () => {
  await closeOpenedManagers();
});

async function call(registry: ToolRegistry, store: Store, agentId: string, args: Record<string, unknown> = {}) {
  const name = String((await mcpNames(registry, agentId))[0]);
  return registry.get(name)?.execute(args, mcpCtx(store, agentId));
}

describe('production execution MCP assembly', () => {
  let server: McpHttpServer;
  // The fixture server listens on loopback; the MCP guard refuses that unless the test escape hatch is set.
  const previousPrivateHosts = process.env.MCP_ALLOW_PRIVATE_HOSTS;

  beforeAll(() => {
    process.env.MCP_ALLOW_PRIVATE_HOSTS = '1';
  });

  afterAll(() => {
    if (previousPrivateHosts === undefined) delete process.env.MCP_ALLOW_PRIVATE_HOSTS;
    else process.env.MCP_ALLOW_PRIVATE_HOSTS = previousPrivateHosts;
  });

  beforeEach(async () => {
    server = await startMcpHttpServer('composed', 'echo');
  });

  afterEach(async () => {
    await server.close();
  });

  it('exposes and calls an API-configured HTTP connection with no injected manager', async () => {
    const store = scopedStore();
    await store.put('agents', mcpAgent('agent-a', ['plugin-1', 'plugin-2']));
    await store.put('connections', mcpConnection({ id: 'conn-http', name: 'Composed', url: server.url, pluginId: 'plugin-1' }));
    await store.put('connections', mcpConnection({ id: 'conn-stdio', name: 'Stdio', command: process.execPath, args: ['-e', '0'], pluginId: 'plugin-2' }));
    const tools = await executionTools(store);
    const names = await mcpNames(tools, 'agent-a');
    // HTTP works without a computer; the stdio server is explicitly unsupported and never host-spawned.
    expect(names).toHaveLength(1);
    expect(names[0]).toBe('composed_echo');
    const result = await call(tools, store, 'agent-a', { q: 1 });
    expect(result?.isError).not.toBe(true);
    expect(JSON.stringify(result?.content)).toContain('composed:');
    expect(server.calls).toEqual(expect.arrayContaining(['initialize', 'tools/list', 'tools/call']));
  });

  it('runs a configured stdio server inside the agent computer through the real assembly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vomu-compose-'));
    const script = writeMcpStdioServer(root);
    try {
      const store = scopedStore();
      await store.put('agents', mcpAgent('agent-a', ['plugin-1']));
      await store.put('connections', mcpConnection({ id: 'conn-stdio', name: 'Stdio', command: process.execPath, args: [script], pluginId: 'plugin-1' }));
      const computer = new PosixProcessClient();
      const tools = await executionTools(store, computer);
      expect(await mcpNames(tools, 'agent-a')).toHaveLength(1);
      const result = await call(tools, store, 'agent-a', { z: 9 });
      expect(result?.isError).not.toBe(true);
      expect(JSON.stringify(result?.content)).toContain('stdio:');
      // The bridge is bound per agent, never to a fixed first agent.
      expect(computer.agentIds.length).toBeGreaterThan(0);
      expect(computer.agentIds.every((id) => id === 'agent-a')).toBe(true);
    } finally {
      // Close before removing the root: a stdio stop runs with that directory as its working directory.
      await closeOpenedManagers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs one shared stdio connection in each agent OWN computer, with collision-free names', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vomu-shared-'));
    const script = writeMcpStdioServer(root);
    const computer = new AgentScopedProcessClient();
    try {
      const store = scopedStore();
      await store.put('agents', mcpAgent('agent-a', ['plugin-s']));
      await store.put('agents', mcpAgent('agent-b', ['plugin-s']));
      // One stdio connection shared by both agents, plus a second server whose sanitized name collides.
      await store.put('connections', mcpConnection({ id: 'conn-s', name: 'Shared', command: process.execPath, args: [script], pluginId: 'plugin-s' }));
      await store.put('connections', mcpConnection({ id: 'conn-t', name: 'Shared!', url: server.url, pluginId: 'plugin-s' }));
      const tools = await executionTools(store, computer);
      const namesA = await mcpNames(tools, 'agent-a');
      expect(namesA).toHaveLength(2);
      // Listing agent-a must have used agent-a's computer only.
      expect(computer.callsFor('agent-a')).toBeGreaterThan(0);
      expect(computer.callsFor('agent-b')).toBe(0);
      expect((await call(tools, store, 'agent-a'))?.isError).not.toBe(true);
      expect(computer.callsFor('agent-b')).toBe(0);
      // The SAME connection for agent-b must run in agent-b's computer, never agent-a's session.
      const namesB = await mcpNames(tools, 'agent-b');
      expect(computer.callsFor('agent-b')).toBeGreaterThan(0);
      expect(new Set([...namesA, ...namesB]).size).toBe(2);
      expect([...namesA].sort()).toEqual([...namesB].sort());
      const forB = (await tools.forAgent('agent-b')).find((tool) => tool.name === namesA[0]);
      expect((await forB?.execute({ from: 'b' }, mcpCtx(store, 'agent-b')))?.isError).not.toBe(true);
      expect(computer.roots()).toHaveLength(2);
    } finally {
      await closeOpenedManagers();
      for (const path of computer.roots()) rmSync(path, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a listed MCP tool executed from another agent or owner context', async () => {
    const store = scopedStore();
    await store.put('agents', mcpAgent('agent-a', ['plugin-1']));
    await store.put('connections', mcpConnection({ id: 'conn-a', name: 'S', url: server.url, pluginId: 'plugin-1' }));
    const tools = await executionTools(store);
    const listed = (await tools.forAgent('agent-a')).find((tool) => tool.mcp === true);
    expect(listed).toBeDefined();
    const wrongAgent = await listed?.execute({}, mcpCtx(store, 'agent-b'));
    expect(wrongAgent?.isError).toBe(true);
    const wrongOwner = await listed?.execute({}, { ...mcpCtx(store, 'agent-a'), ownerId: 'owner-2' });
    expect(wrongOwner?.isError).toBe(true);
  });

  it('refuses a cached MCP tool after the user disconnects the server', async () => {
    const store = scopedStore();
    await store.put('agents', mcpAgent('agent-a', ['plugin-1']));
    await store.put('connections', mcpConnection({ id: 'conn-a', name: 'S', url: server.url, pluginId: 'plugin-1' }));
    const tools = await executionTools(store);
    const cached = (await tools.forAgent('agent-a')).find((tool) => tool.mcp === true);
    expect(cached).toBeDefined();
    // What the API does when the user revokes a connection, seen by the already-listed tool.
    await store.patch('connections', 'conn-a', { status: 'disconnected', enabled: false });
    const cachedResult = await cached?.execute({}, mcpCtx(store, 'agent-a'));
    expect(cachedResult?.isError).toBe(true);
    expect(JSON.stringify(cachedResult?.content)).toContain('is not added yet');
  });

  it('aborts MCP discovery promptly when the run is cancelled during initialize', async () => {
    const hanging = await startMcpHttpServer('hang', 'echo', true);
    try {
      const store = scopedStore();
      await store.put('agents', mcpAgent('agent-a', ['plugin-1']));
      await store.put('connections', mcpConnection({ id: 'conn-hang', name: 'Hang', url: hanging.url, pluginId: 'plugin-1' }));
      const tools = await executionTools(store);
      const controller = new AbortController();
      const started = Date.now();
      const discovery = tools.forAgent('agent-a', { signal: controller.signal });
      setTimeout(() => controller.abort(new Error('run stopped')), 40);
      let names: string[] = [];
      try {
        names = (await discovery).filter((tool) => tool.mcp === true).map((tool) => tool.name);
      } catch {
        names = [];
      }
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(names).toEqual([]);
    } finally {
      await hanging.close();
    }
  });

  it('never invents an MCP tool without the runtime, and startExecution builds this assembly', async () => {
    const store = scopedStore();
    const bare = await createToolRegistry({ store, enqueuer: new NoopEnqueuer() });
    expect(bare.get('mcp.0123456789.echo_01234567')).toBeUndefined();
    const source = await readFile(new URL('../execution/start.ts', import.meta.url), 'utf8');
    expect(source).toContain('createVomuAgent(');
    expect(source).not.toMatch(/createToolRegistry\(/);
  });
});

describe('bound sandbox stdio MCP bridge', () => {
  let root: string;
  let script: string;
  // The stdio server is a real process; teardown stops it even when an assertion fails before client.close().
  let posix: PosixProcessClient | undefined;
  let opened: { handle: string } | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vomu-mcp-'));
    script = writeMcpStdioServer(root);
  });

  afterEach(async () => {
    if (posix !== undefined && opened !== undefined) await posix.stopProcess('agent-a', { handle: opened.handle }).catch(() => undefined);
    posix = undefined;
    opened = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('runs a real stdio server through the bridge, keeps stderr out of the protocol and stops it', async () => {
    const diagnostics: string[] = [];
    posix = new PosixProcessClient();
    const bridge = createSandboxStdioBridge({ client: posix, agentId: 'agent-a', onStderr: (text) => diagnostics.push(text) });
    const channel = await bridge.open({ command: process.execPath, args: [script] });
    opened = channel;
    const client = new McpClient(() => new StdioMcpTransport({ bridge: { open: async () => channel }, command: process.execPath, args: [script] }));
    expect((await client.connect()).state).toBe('connected');
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(['echo']);
    expect((await client.callTool('echo', { ping: 1 })).text).toContain('stdio:');
    await client.close();
    expect(diagnostics.join('')).toContain('mcp-stdio-server: started');
    expect(diagnostics.join('')).toContain('diag: tools/list');
    // close() awaited the sandbox stop, so the recorded state is already terminal.
    expect((await posix.readProcess('agent-a', { handle: opened.handle })).state).toBe('stopped');
  });
});

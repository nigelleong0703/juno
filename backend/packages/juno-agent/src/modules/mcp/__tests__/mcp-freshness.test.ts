// M-MCPDISC: protocol era negotiation (2026-07-28 server/discover with a probe timeout, legacy initialize fallback),
// tool-list freshness (ttlMs, the legacy 10-minute default, list_changed on both streams, one re-list per run turn,
// a re-list before a call that finds no such tool), the cache-safety rules (the array in use is never mutated), and
// the modern HTTP request rules (routing headers, x-mcp-header mirroring, input_required refused).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { McpClient, McpToolRemovedError } from '../client.js';
import { HttpMcpTransport } from '../http-transport.js';
import { startFreshServer, type FreshServer, type FreshServerOptions, type FreshTool } from './mcp-freshness.fixtures.js';

// The fixtures run on 127.0.0.1; the MCP guard refuses loopback unless the test escape hatch is set.
let previousPrivateHosts: string | undefined;
beforeAll(() => {
  previousPrivateHosts = process.env.MCP_ALLOW_PRIVATE_HOSTS;
  process.env.MCP_ALLOW_PRIVATE_HOSTS = '1';
});
afterAll(() => {
  if (previousPrivateHosts === undefined) delete process.env.MCP_ALLOW_PRIVATE_HOSTS;
  else process.env.MCP_ALLOW_PRIVATE_HOSTS = previousPrivateHosts;
});

const servers: FreshServer[] = [];
const clients: McpClient[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (clients.length > 0) await clients.pop()?.close();
  while (servers.length > 0) await servers.pop()?.close();
});

async function server(options: FreshServerOptions): Promise<FreshServer> {
  const started = await startFreshServer(options);
  servers.push(started);
  return started;
}

function clientFor(fresh: FreshServer, options: { listenRetryMs?: number; probeTimeoutMs?: number } = {}): McpClient {
  const client = new McpClient(() => new HttpMcpTransport({ url: fresh.url }), options);
  clients.push(client);
  return client;
}

const names = (client: McpClient): string[] => client.discoveredTools().map((tool) => tool.name);

/** Polls a refresh until it re-lists (a notification marks the list stale asynchronously). */
async function relistsSoon(client: McpClient): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await client.refreshIfStale()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('protocol era negotiation', () => {
  it('reaches a modern server with server/discover, with no initialize and _meta on every request', async () => {
    const fresh = await server({ era: 'modern' });
    const client = clientFor(fresh);
    const status = await client.connect();
    await client.discoverTools();
    expect(status.protocolVersion).toBe('2026-07-28');
    expect(status.serverName).toBe('fresh');
    expect(fresh.calls['initialize']).toBeUndefined();
    expect(fresh.calls['server/discover']).toBe(1);
    expect(client.serverInstructions()).toBe('Use the tools with care.');
    expect(names(client)).toEqual(['echo', 'ping']);
    expect(fresh.missingMeta).toBe(0);
    expect(fresh.seen.filter((request) => request.method === 'tools/list').every((request) => request.hasMeta && request.protocolVersion === '2026-07-28')).toBe(true);
  });

  it('falls back to the initialize handshake when a legacy server answers server/discover with method-not-found', async () => {
    const fresh = await server({ era: 'legacy' });
    const client = clientFor(fresh);
    const status = await client.connect();
    await client.discoverTools();
    expect(status.protocolVersion).toBe('2025-06-18');
    expect(fresh.calls['server/discover']).toBe(1);
    expect(fresh.calls['initialize']).toBe(1);
    expect(client.serverInstructions()).toBe('Legacy guidance.');
    expect(names(client)).toEqual(['echo', 'ping']);
    // The legacy path sends no 2026 header and no _meta.
    expect(fresh.seen.filter((request) => request.method === 'tools/list').every((request) => !request.hasMeta && request.protocolVersion === '2025-06-18')).toBe(true);
  });

  it('keeps the legacy handshake when a discover lists only legacy versions', async () => {
    const fresh = await server({ era: 'modern', discoverVersions: ['2025-06-18'] });
    const client = clientFor(fresh);
    const status = await client.connect();
    await client.discoverTools();
    expect(status.protocolVersion).toBe('2025-06-18');
    expect(fresh.calls['initialize']).toBe(1);
  });

  it('gives up on a silent probe after its timeout and takes the legacy handshake', async () => {
    const fresh = await server({ era: 'legacy', silentDiscover: true });
    const client = clientFor(fresh, { probeTimeoutMs: 100 });
    const started = Date.now();
    const status = await client.connect();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(status.protocolVersion).toBe('2025-06-18');
    expect(fresh.calls['server/discover']).toBe(1);
    expect(fresh.calls['initialize']).toBe(1);
  });
});

describe('tool list freshness', () => {
  it('keeps a modern list fresh for its ttlMs, then re-lists once it expires', async () => {
    const fresh = await server({ era: 'modern', ttlMs: 60_000 });
    const client = clientFor(fresh);
    await client.connect();
    await client.discoverTools();
    expect(fresh.calls['tools/list']).toBe(1);
    expect(await client.refreshIfStale()).toBe(false);
    expect(fresh.calls['tools/list']).toBe(1);
    const base = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(base + 61_000);
    expect(await client.refreshIfStale()).toBe(true);
    expect(fresh.calls['tools/list']).toBe(2);
  });

  it('gives a legacy list with no ttlMs the ten-minute default', async () => {
    const fresh = await server({ era: 'legacy' });
    const client = clientFor(fresh);
    await client.connect();
    await client.discoverTools();
    const base = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(base + 9 * 60_000);
    expect(await client.refreshIfStale()).toBe(false);
    vi.spyOn(Date, 'now').mockReturnValue(base + 10 * 60_000 + 1_000);
    expect(await client.refreshIfStale()).toBe(true);
    expect(fresh.calls['tools/list']).toBe(2);
  });

  it('re-lists a zero-ttl list at most once per run turn, not on every access', async () => {
    const fresh = await server({ era: 'modern', ttlMs: 0 });
    const client = clientFor(fresh);
    await client.connect();
    await client.discoverTools();
    expect(await client.refreshIfStale({ turn: 'run-1:1' })).toBe(true);
    expect(await client.refreshIfStale({ turn: 'run-1:1' })).toBe(false);
    expect(await client.refreshIfStale({ turn: 'run-1:1' })).toBe(false);
    expect(fresh.calls['tools/list']).toBe(2);
    expect(await client.refreshIfStale({ turn: 'run-1:2' })).toBe(true);
    expect(fresh.calls['tools/list']).toBe(3);
  });

  it('re-lists a legacy server after list_changed arrives on its GET stream', async () => {
    const fresh = await server({ era: 'legacy', listChanged: true });
    const client = clientFor(fresh);
    await client.connect();
    await client.discoverTools();
    await until(() => fresh.streams === 1);
    expect(fresh.streams).toBe(1);
    fresh.setTools([{ name: 'echo', description: 'Echo the text' }, { name: 'gamma', description: 'New tool' }]);
    expect(await relistsSoon(client)).toBe(true);
    expect(names(client)).toEqual(['echo', 'gamma']);
  });

  it('re-lists a modern server after list_changed arrives on its subscriptions/listen stream', async () => {
    const fresh = await server({ era: 'modern', listChanged: true, ttlMs: 60_000 });
    const client = clientFor(fresh);
    await client.connect();
    await client.discoverTools();
    await until(() => fresh.streams === 1);
    expect(fresh.calls['subscriptions/listen']).toBe(1);
    fresh.setTools([{ name: 'echo', description: 'Echo the text' }, { name: 'gamma', description: 'New tool' }]);
    expect(await relistsSoon(client)).toBe(true);
    expect(names(client)).toEqual(['echo', 'gamma']);
  });

  it('refuses a call to a tool the server no longer offers, after a fresh list', async () => {
    const fresh = await server({ era: 'legacy' });
    const client = clientFor(fresh);
    await client.connect();
    await client.discoverTools();
    fresh.setTools([{ name: 'echo', description: 'Echo the text' }]);
    const failure = await client.callTool('ping', {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McpToolRemovedError);
    expect((failure as Error).message).toBe('this app no longer offers "ping"; search again with tool_search');
    expect(names(client)).toEqual(['echo']);
  });

  it('checks a name the cached list never held against a fresh list before sending the call', async () => {
    const fresh = await server({ era: 'legacy' });
    const client = clientFor(fresh);
    await client.connect();
    await client.discoverTools();
    await expect(client.callTool('ghost', {})).rejects.toBeInstanceOf(McpToolRemovedError);
    expect(fresh.calls['tools/call']).toBeUndefined();
  });
});

describe('cache safety', () => {
  it('replaces a changed list whole and never mutates the array already handed out', async () => {
    const fresh = await server({ era: 'modern', ttlMs: 0 });
    const client = clientFor(fresh);
    await client.connect();
    await client.discoverTools();
    const before = client.discoveredTools();
    const snapshot = JSON.stringify(before);
    fresh.setTools([{ name: 'echo', description: 'Echo the text' }, { name: 'gamma', description: 'New tool' }]);
    expect(await client.refreshIfStale()).toBe(true);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(names(client)).toEqual(['echo', 'gamma']);
  });

  it('sends modern requests with the routing headers the 2026 transport defines', async () => {
    const fresh = await server({ era: 'modern' });
    const client = clientFor(fresh);
    await client.connect();
    await client.discoverTools();
    await client.callTool('echo', { text: 'hi' });
    const call = fresh.seen.find((request) => request.method === 'tools/call');
    expect(call).toMatchObject({ hasMeta: true, protocolVersion: '2026-07-28', routing: 'tools/call', name: 'echo' });
  });
});

const SQL_TOOLS: FreshTool[] = [
  {
    name: 'execute_sql',
    description: 'Run SQL',
    inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' }, count: { type: 'integer', 'x-mcp-header': 'Count' }, query: { type: 'string' } } },
  },
  { name: 'bad_number', description: 'annotated number', inputSchema: { type: 'object', properties: { amount: { type: 'number', 'x-mcp-header': 'Amount' } } } },
  {
    name: 'bad_items',
    description: 'annotation under items',
    inputSchema: { type: 'object', properties: { list: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', 'x-mcp-header': 'Id' } } } } } },
  },
];

describe('modern HTTP request metadata', () => {
  it('mirrors annotated arguments into Mcp-Param headers, encodes them, omits null ones, and never advertises a bad annotation', async () => {
    const fresh = await server({ era: 'modern' });
    fresh.setTools(SQL_TOOLS);
    const client = clientFor(fresh);
    await client.connect();
    await client.discoverTools();
    expect(names(client)).toEqual(['execute_sql']);

    await client.callTool('execute_sql', { region: 'Hello, 世界', count: 3, query: 'select 1' });
    await client.callTool('execute_sql', { region: null, count: 0, query: 'select 2' });
    const calls = fresh.seen.filter((request) => request.method === 'tools/call');
    expect(calls[0]?.params).toEqual({ 'mcp-param-region': '=?base64?SGVsbG8sIOS4lueVjA==?=', 'mcp-param-count': '3' });
    expect(calls[1]?.params).toEqual({ 'mcp-param-count': '0' });
  });

  it('refuses a multi round-trip (input_required) result with a clear error', async () => {
    const fresh = await server({ era: 'modern' });
    fresh.setTools([{ name: 'ask', description: 'Ask the user' }]);
    const client = clientFor(fresh);
    await client.connect();
    await client.discoverTools();
    await expect(client.callTool('ask', {})).rejects.toThrow(/multi round-trip/);
  });
});

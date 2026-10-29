// PH7 production manager: owner-scoped discovery/invocation, ctx-validated cached bindings, unique
// tool names, unconditional agent authorization, signal-bounded discovery and truthful status.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import type { Store, ToolContext } from '../../../contracts/index.js';
import type { Agent } from '@agent-desktop/public-contracts';
import { McpAuthError, McpConnectionError, createMcpManager, createMcpTool, isSchemaWithinBound, mcpConnectionPrefixes, mcpToolName, mcpToolNames } from '../index.js';
import { NOW, markerStdioBridge, resultText, startFixture, toolContext, waitFor, type Fixture } from './mcp-runtime.fixtures.js';

const OWNER = 'owner-a';
const AGENT = 'agent-a';

interface SeedConnection {
  id: string;
  kind: 'mcp';
  name: string;
  status: 'disconnected';
  endpoint: string;
  ownerId: string;
  enabled: boolean;
  transport: 'http';
  pluginId?: string;
}

function agentDoc(id: string, owner: string, pluginIds: string[] = []): Agent & { ownerId: string } {
  return {
    id,
    name: 'Agent ' + id,
    handle: id,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'Test agent',
    status: 'idle',
    section: 'Agents',
    pinned: false,
    lastActivity: NOW,
    unreadCount: 0,
    channels: [],
    macAccess: false,
    skillIds: [],
    pluginIds,
    sharing: { publishedToTeam: false },
    createdAt: NOW,
    updatedAt: NOW,
    ownerId: owner,
  };
}

function scopedStore(store: Store, owner: string): Store {
  const scoped = store.forOwner?.(owner);
  if (!scoped) throw new Error('test store is missing forOwner');
  return scoped;
}

async function putConnection(store: Store, id: string, url: string, pluginId?: string): Promise<void> {
  const doc: SeedConnection = {
    id,
    kind: 'mcp',
    name: 'Fixture Server',
    status: 'disconnected',
    endpoint: url,
    ownerId: OWNER,
    enabled: true,
    transport: 'http',
    ...(pluginId === undefined ? {} : { pluginId }),
  };
  await store.put('connections', doc);
}

async function putStdioConnection(store: Store, id: string): Promise<void> {
  const doc = { id, kind: 'mcp' as const, name: 'Stdio Server', status: 'disconnected' as const, endpoint: 'stdio-server', ownerId: OWNER, enabled: true, transport: 'stdio' as const, args: [] as string[] };
  await store.put('connections', doc);
}

async function seeded(pluginIds: string[] = []): Promise<Store> {
  const store = createMemoryStore();
  const scoped = scopedStore(store, OWNER);
  await scoped.put('agents', agentDoc(AGENT, OWNER, pluginIds));
  return scoped;
}

function ctxFor(store: Store): ToolContext {
  return { ...toolContext(), store, agentId: AGENT };
}

describe('PH7 MCP production manager', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await startFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it('exposes discovered tools and invokes them through the manager', async () => {
    const scoped = await seeded();
    await putConnection(scoped, 'con-1', fixture.url);
    const tools = await createMcpManager().toolsForAgent({ ownerId: OWNER, store: scoped, agentId: AGENT });
    const echo = tools.find((tool) => tool.name === mcpToolName('fixture_server', 'echo'));
    expect(echo).toBeDefined();
    expect(echo?.replay).toBe('never');
    const result = await echo?.execute({ text: 'manager' }, ctxFor(scoped));
    expect(result === undefined ? '' : resultText(result)).toContain('echo:manager');
  });

  it('never lets a cached tool run under a foreign owner or agent context', async () => {
    const scoped = await seeded();
    await putConnection(scoped, 'con-1', fixture.url);
    const echo = (await createMcpManager().toolsForAgent({ ownerId: OWNER, store: scoped, agentId: AGENT })).find(
      (tool) => tool.name === mcpToolName('fixture_server', 'echo'),
    );
    const foreignAgent = await echo?.execute({}, { ...ctxFor(scoped), agentId: 'agent-x' });
    expect(foreignAgent?.isError).toBe(true);
    expect(JSON.stringify(foreignAgent?.content)).toContain('different owner or agent');
    const foreignOwner = await echo?.execute({}, { ...ctxFor(scoped), ownerId: 'owner-b' });
    expect(foreignOwner?.isError).toBe(true);
  });

  it('gives same-named servers and sanitize-colliding tools distinct names', async () => {
    expect(mcpToolNames('fixture_server', ['foo-bar', 'foo.bar']).get('foo-bar')).not.toBe(mcpToolNames('fixture_server', ['foo-bar', 'foo.bar']).get('foo.bar'));
    const scoped = await seeded();
    await putConnection(scoped, 'con-1', fixture.url);
    await putConnection(scoped, 'con-2', fixture.url);
    const names = (await createMcpManager().toolsForAgent({ ownerId: OWNER, store: scoped, agentId: AGENT })).map((tool) => tool.name);
    const echoes = names.filter((name) => name.endsWith('_echo'));
    expect(echoes).toHaveLength(2);
    expect(new Set(echoes).size).toBe(2);
    expect(echoes.every((name) => name.startsWith('fixture_server_'))).toBe(true);
  });

  it('authorizes the agent on every call, even for a connection with no plugin binding', async () => {
    const scoped = await seeded();
    await putConnection(scoped, 'con-1', fixture.url);
    const manager = createMcpManager();
    const outcome = await manager.callTool({ ownerId: OWNER, store: scoped, agentId: AGENT, connectionId: 'con-1', toolName: 'echo', args: { text: 'x' } });
    expect(outcome.text).toBe('echo:x');
    await expect(
      manager.callTool({ ownerId: OWNER, store: scoped, agentId: 'agent-missing', connectionId: 'con-1', toolName: 'echo', args: {} }),
    ).rejects.toBeInstanceOf(McpConnectionError);
  });

  it('re-checks at execute time and refuses after the user disconnects', async () => {
    const scoped = await seeded();
    await putConnection(scoped, 'con-1', fixture.url);
    const manager = createMcpManager();
    await manager.disconnect({ ownerId: OWNER, store: scoped, connectionId: 'con-1' });
    await expect(
      manager.callTool({ ownerId: OWNER, store: scoped, agentId: AGENT, connectionId: 'con-1', toolName: 'echo', args: {} }),
    ).rejects.toThrow(/is not added yet.*Apps page/);
    const after = (await manager.toolsForAgent({ ownerId: OWNER, store: scoped, agentId: AGENT })).map((tool) => tool.name);
    expect(after).toHaveLength(0);
  });

  it('persists a truthful status lifecycle without auto-disabling a configured server', async () => {
    const scoped = await seeded();
    await putConnection(scoped, 'con-1', fixture.url);
    const manager = createMcpManager();
    expect((await manager.connect({ ownerId: OWNER, store: scoped, connectionId: 'con-1' })).state).toBe('connected');
    expect((await scoped.get('connections', 'con-1'))?.status).toBe('connected');
    expect((await scoped.get('connections', 'con-1'))?.enabled).toBe(true);

    await putConnection(scoped, 'con-auth', fixture.authUrl);
    await expect(manager.connect({ ownerId: OWNER, store: scoped, connectionId: 'con-auth' })).rejects.toBeInstanceOf(McpAuthError);
    expect((await scoped.get('connections', 'con-auth'))?.status).toBe('error');
    expect((await scoped.get('connections', 'con-auth'))?.enabled).toBe(true);
  });

  it('refuses a connection recorded for another owner and isolates by scope', async () => {
    const store = createMemoryStore();
    await putConnection(scopedStore(store, OWNER), 'con-1', fixture.url);
    await expect(
      createMcpManager().connect({ ownerId: 'owner-b', store: scopedStore(store, 'owner-b'), connectionId: 'con-1' }),
    ).rejects.toBeInstanceOf(McpConnectionError);
  });

  it('propagates discovery cancellation instead of returning an empty catalog', async () => {
    const scoped = await seeded();
    await putConnection(scoped, 'con-1', fixture.slowListUrl);
    const controller = new AbortController();
    const started = Date.now();
    const pending = createMcpManager().toolsForAgent({ ownerId: OWNER, store: scoped, agentId: AGENT, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('keeps names model-compatible for long or unicode tool names', () => {
    const pattern = /^[a-zA-Z0-9_-]{1,64}$/;
    expect(mcpToolName('fixture_server', 'x'.repeat(200))).toMatch(pattern);
    expect(mcpToolName('fixture_server', 'x'.repeat(200)).length).toBeLessThanOrEqual(64);
    expect(mcpToolName('youtube', 'search')).toBe('youtube_search');
    // These sanitize to the same name; the tools of one connection then carry a hash of the server's own name.
    const names = mcpToolNames('fixture_server', ['caf\u00e9', 'caf_']);
    expect(names.get('caf\u00e9')).not.toBe(names.get('caf_'));
    expect(names.get('caf\u00e9')).toMatch(pattern);
  });

  it('names connections by connector, adding the account only for two of one connector', () => {
    const one = mcpConnectionPrefixes([{ id: 'a', name: 'Gmail', catalogId: 'gmail' }, { id: 'b', name: 'YouTube Music', catalogId: 'youtube-music' }, { id: 'c', name: 'My Server' }]);
    expect(Object.fromEntries(one)).toEqual({ a: 'gmail', b: 'youtube_music', c: 'my_server' });
    const two = mcpConnectionPrefixes([{ id: 'a', name: 'Gmail', catalogId: 'gmail', account: 'Work' }, { id: 'b', name: 'Gmail', catalogId: 'gmail', account: 'Home' }, { id: 'c', name: 'YouTube', catalogId: 'youtube' }]);
    expect(Object.fromEntries(two)).toEqual({ a: 'gmail_work', b: 'gmail_home', c: 'youtube' });
    // An unrelated connection never changes a name.
    expect(mcpConnectionPrefixes([{ id: 'c', name: 'YouTube', catalogId: 'youtube' }]).get('c')).toBe('youtube');
  });

  it('bounds a tool description and rejects an oversized parameter schema', () => {
    const tool = {
      name: 'big-tool',
      description: 'D'.repeat(2000),
      inputSchema: { type: 'object', properties: { a: { description: 'E'.repeat(20000) } } },
    };
    expect(isSchemaWithinBound(tool)).toBe(false);
    expect(isSchemaWithinBound({ name: 'small', inputSchema: { type: 'object', properties: {} } })).toBe(true);
    const bound = createMcpTool({
      ownerId: OWNER,
      agentId: AGENT,
      connectionId: 'con-1',
      connectionName: 'Server',
      name: 'server_big_tool',
      tool,
      catalogTruncated: false,
      access: 'action',
      manager: createMcpManager(),
    });
    expect(bound.description.length).toBeLessThanOrEqual(1001);
  });

  it('partitions stdio sessions per agent so one agent never runs on another computer', async () => {
    const store = createMemoryStore();
    const scoped = scopedStore(store, OWNER);
    await scoped.put('agents', agentDoc(AGENT, OWNER));
    await scoped.put('agents', agentDoc('agent-b', OWNER));
    await putStdioConnection(scoped, 'con-1');
    const manager = createMcpManager({ stdioForAgent: ({ agentId }) => markerStdioBridge('ran-on-' + String(agentId)) });

    const echoName = mcpToolName('stdio_server', 'echo');
    const a = (await manager.toolsForAgent({ ownerId: OWNER, store: scoped, agentId: AGENT })).find((tool) => tool.name === echoName);
    const b = (await manager.toolsForAgent({ ownerId: OWNER, store: scoped, agentId: 'agent-b' })).find((tool) => tool.name === echoName);
    const aOut = await a?.execute({}, { ...toolContext(), store: scoped, agentId: AGENT });
    const bOut = await b?.execute({}, { ...toolContext(), store: scoped, agentId: 'agent-b' });
    expect(JSON.stringify(aOut?.content)).toContain('ran-on-' + AGENT);
    expect(JSON.stringify(bOut?.content)).toContain('ran-on-agent-b');
  });

  it('carries real MCP image bytes into the registry tool result', async () => {
    const scoped = await seeded();
    await putConnection(scoped, 'con-1', fixture.url);
    const tool = (await createMcpManager().toolsForAgent({ ownerId: OWNER, store: scoped, agentId: AGENT })).find(
      (candidate) => candidate.name === mcpToolName('fixture_server', 'image'),
    );
    const result = await tool?.execute({}, ctxFor(scoped));
    expect(result?.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' });
    expect(result?.isError).not.toBe(true);
  });

  it('exposes the full result to the artifact boundary when the display is truncated', async () => {
    const scoped = await seeded();
    await putConnection(scoped, 'con-1', fixture.url);
    const tool = (await createMcpManager().toolsForAgent({ ownerId: OWNER, store: scoped, agentId: AGENT })).find(
      (candidate) => candidate.name === mcpToolName('fixture_server', 'huge'),
    );
    const result = await tool?.execute({}, ctxFor(scoped));
    expect(result?.details?.truncated).toBe(true);
    expect(String(result?.details?.fullContent).length).toBe(96_000);
    expect(resultText(result ?? { content: [] }).length).toBeLessThanOrEqual(20_300);
  });

  it('never resurrects a connection revoked while it was connecting', async () => {
    const scoped = await seeded();
    await putConnection(scoped, 'con-1', fixture.slowListUrl);
    const manager = createMcpManager();
    const pending = manager.connect({ ownerId: OWNER, store: scoped, connectionId: 'con-1' });
    await waitFor(() => fixture.state.protocolVersions.length > 0, 1000);
    await manager.disconnect({ ownerId: OWNER, store: scoped, connectionId: 'con-1' });
    await expect(pending).rejects.toBeTruthy();
    const doc = await scoped.get('connections', 'con-1');
    expect(doc?.status).toBe('disconnected');
    expect(doc?.enabled).toBe(false);
  });

  it('cancels a pending call when another process revokes the connection', async () => {
    const scoped = await seeded();
    await putConnection(scoped, 'con-1', fixture.url);
    const caller = createMcpManager();
    const api = createMcpManager();
    const started = Date.now();
    const pending = caller.callTool({ ownerId: OWNER, store: scoped, agentId: AGENT, connectionId: 'con-1', toolName: 'slow', args: {} });
    await waitFor(() => fixture.state.protocolVersions.length > 0, 1000);
    await api.disconnect({ ownerId: OWNER, store: scoped, connectionId: 'con-1' });
    await expect(pending).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(3000);
    const doc = await scoped.get('connections', 'con-1');
    expect(doc?.status).toBe('disconnected');
    expect(doc?.enabled).toBe(false);
  });

  it('reports the canonical row state instead of a cached connected session', async () => {
    const scoped = await seeded();
    await putConnection(scoped, 'con-1', fixture.url);
    const manager = createMcpManager();
    await manager.connect({ ownerId: OWNER, store: scoped, connectionId: 'con-1' });
    expect((await manager.status({ ownerId: OWNER, store: scoped, connectionId: 'con-1' }))?.state).toBe('connected');
    await scoped.patch('connections', 'con-1', { status: 'disconnected', enabled: false });
    expect((await manager.status({ ownerId: OWNER, store: scoped, connectionId: 'con-1' }))?.state).toBe('disconnected');
  });
});

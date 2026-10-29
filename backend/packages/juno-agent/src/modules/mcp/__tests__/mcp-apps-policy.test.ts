// Apps (BACKEND 10.18) at the MCP manager: which apps an agent sees, which tools are offered by the app's Actions policy, and that a call is
// refused at the manager whatever tool list the agent still holds. A stdio bridge stands in for the server so each tool carries the annotation under test.
import { describe, expect, it } from 'vitest';
import type { Agent, ActionsPolicy } from '@agent-desktop/public-contracts';
import { createMemoryStore } from '../../../testing/store.js';
import type { Store, ToolContext } from '../../../contracts/index.js';
import { createConnectorCatalog } from '../catalog.js';
import { createStoredCatalog, entryRow } from '../../apps/catalog.js';
import { createMcpManager, McpConnectionError, type SandboxStdioBridge, type SandboxStdioChannel } from '../index.js';
import { setAgentApp } from '../../apps/agent-apps.js';
import { NOW, isRecord, toolContext } from './mcp-runtime.fixtures.js';

const OWNER = 'owner-a';
const TOOLS = [
  { name: 'list_things', description: 'List things', annotations: { readOnlyHint: true } },
  { name: 'create_thing', description: 'Create a thing' },
  { name: 'wipe', description: 'Delete everything', annotations: { destructiveHint: true } },
  { name: 'export', description: 'Export a file', annotations: { readOnlyHint: false } },
];

/** A stdio server that lists TOOLS and answers every call with `ran:<tool>`. */
function toolsBridge(): SandboxStdioBridge {
  return {
    async open(): Promise<SandboxStdioChannel> {
      let handler: ((line: string) => void) | undefined;
      return {
        send(line: string): void {
          const parsed: unknown = JSON.parse(line);
          if (!isRecord(parsed)) return;
          const id = parsed['id'];
          const params = isRecord(parsed['params']) ? parsed['params'] : {};
          const answer = (result: Record<string, unknown>): void => queueMicrotask(() => handler?.(JSON.stringify({ jsonrpc: '2.0', id, result })));
          if (parsed['method'] === 'initialize') answer({ protocolVersion: '2024-11-05', serverInfo: { name: 'things', version: '1' } });
          else if (parsed['method'] === 'tools/list') answer({ tools: TOOLS });
          else if (parsed['method'] === 'tools/call') answer({ content: [{ type: 'text', text: 'ran:' + String(params['name']) }] });
          else if (parsed['method'] === 'server/discover') queueMicrotask(() => handler?.(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })));
        },
        onMessage(next: (line: string) => void): void { handler = next; },
        async close(): Promise<void> {},
      };
    },
  };
}

function agentDoc(id: string): Agent & { ownerId: string } {
  return {
    id, name: 'Agent ' + id, handle: id, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 'Test agent', status: 'idle', section: 'Agents', pinned: false,
    lastActivity: NOW, unreadCount: 0, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdAt: NOW, updatedAt: NOW, ownerId: OWNER,
  };
}

async function seeded(catalogId?: string): Promise<{ store: Store; appId: string }> {
  const scoped = createMemoryStore().forOwner?.(OWNER);
  if (scoped === undefined) throw new Error('test store is missing forOwner');
  await scoped.put('agents', agentDoc('agent-a'));
  await scoped.put('agents', agentDoc('agent-b'));
  await scoped.put('connections', { id: 'con-things', kind: 'mcp', name: 'Things', status: 'disconnected', endpoint: 'things-server', ownerId: OWNER, enabled: true, transport: 'stdio', args: [], ...(catalogId === undefined ? {} : { catalogId }) } as never);
  return { store: scoped, appId: catalogId ?? 'con-things' };
}

const manager = (catalog?: ReturnType<typeof createConnectorCatalog>) => createMcpManager({ stdioForAgent: () => toolsBridge(), ...(catalog === undefined ? {} : { catalog }) });
const offered = async (store: Store, agentId: string, catalog?: ReturnType<typeof createConnectorCatalog>) =>
  new Map((await manager(catalog).toolsForAgent({ ownerId: OWNER, store, agentId })).map((tool) => [tool.origin?.toolName ?? tool.name, tool] as const));
const policy = (store: Store, appId: string, actionsPolicy: ActionsPolicy, agentId = 'agent-a', enabled = true) => setAgentApp(store, { ownerId: OWNER, agentId, appId, enabled, actionsPolicy });

describe('Apps at the MCP manager', () => {
  it('offers every tool of an app nobody configured, each marked read or action; only a server mark makes a read', async () => {
    const { store } = await seeded();
    const tools = await offered(store, 'agent-a');
    expect([...tools.keys()].sort()).toEqual(['create_thing', 'export', 'list_things', 'wipe']);
    expect([...tools].map(([name, tool]) => [name, tool.origin?.access])).toEqual([['list_things', 'read'], ['create_thing', 'action'], ['wipe', 'action'], ['export', 'action']]);
    expect(tools.get('create_thing')?.origin?.actions).toBeUndefined();
  });

  it('Allow marks the app\'s action tools for the policy; Ask first (the default) leaves them as they are', async () => {
    const { store, appId } = await seeded();
    await policy(store, appId, 'allow');
    expect((await offered(store, 'agent-a')).get('create_thing')?.origin?.actions).toBe('allow');
    expect((await offered(store, 'agent-b')).get('create_thing')?.origin?.actions).toBeUndefined();
  });

  it('Off hides every action tool and refuses a call to one, even one the agent still holds; reads keep working', async () => {
    const { store, appId } = await seeded();
    const tools = await offered(store, 'agent-a');
    await policy(store, appId, 'off');
    expect([...(await offered(store, 'agent-a')).keys()]).toEqual(['list_things']);
    expect([...(await offered(store, 'agent-b')).keys()]).toHaveLength(4);
    const ctx: ToolContext = { ...toolContext(), store, agentId: 'agent-a' };
    await expect(tools.get('create_thing')?.execute({}, ctx)).resolves.toMatchObject({ isError: true, content: [{ text: expect.stringContaining('Actions is off') }] });
    await expect(tools.get('list_things')?.execute({}, ctx)).resolves.toMatchObject({ content: [{ text: 'ran:list_things' }] });
    await expect(manager().callTool({ ownerId: OWNER, store, agentId: 'agent-a', connectionId: 'con-things', toolName: 'not_listed', args: {} })).rejects.toBeInstanceOf(McpConnectionError);
  });

  it('turning an app off for an agent removes all its tools and refuses its calls; other agents keep it', async () => {
    const { store, appId } = await seeded();
    const tools = await offered(store, 'agent-a');
    await policy(store, appId, 'ask', 'agent-a', false);
    expect((await offered(store, 'agent-a')).size).toBe(0);
    expect((await offered(store, 'agent-b')).size).toBe(4);
    const ctx: ToolContext = { ...toolContext(), store, agentId: 'agent-a' };
    await expect(tools.get('list_things')?.execute({}, ctx)).resolves.toMatchObject({ isError: true, content: [{ text: expect.stringContaining('is turned off for you') }] });
  });

  it('our curated table beats the server: a named tool, and a read-only app', async () => {
    const entry = { id: 'acme', name: 'Acme', icon: 'x', description: 'Acme things.', category: 'productivity' as const, url: 'https://mcp.acme.test/mcp' };
    const named = await seeded('acme');
    const byName = await offered(named.store, 'agent-a', createConnectorCatalog([{ ...entry, toolAccess: { export: 'read', list_things: 'change' } }]));
    expect(byName.get('export')?.origin?.access).toBe('read');
    expect(byName.get('list_things')?.origin?.access).toBe('action');
    const readOnly = await seeded('acme');
    const all = await offered(readOnly.store, 'agent-a', createConnectorCatalog([{ ...entry, readOnly: true }]));
    expect([...all.values()].map((tool) => tool.origin?.access)).toEqual(['read', 'read', 'read', 'read']);
    // listTools (the Apps page) says the same thing, as a change or a read.
    expect((await manager(createConnectorCatalog([{ ...entry, toolAccess: { export: 'read' } }])).listTools({ ownerId: OWNER, store: named.store, connectionId: 'con-things' })).map((tool) => [tool.name, tool.access])).toEqual([['list_things', 'read'], ['create_thing', 'action'], ['wipe', 'action'], ['export', 'read']]);
  });

  it('the app catalog table decides the tool scope: hiding an app keeps it working for the owners who added it, retiring it takes its tools away without a restart', async () => {
    const entry = { id: 'acme', name: 'Acme', icon: 'x', description: 'Acme things.', category: 'productivity' as const, url: 'https://mcp.acme.test/mcp' };
    const { store } = await seeded('acme');
    const catalog = await createStoredCatalog({ store: createMemoryStore(), seed: [entryRow(entry, NOW)] });
    expect((await offered(store, 'agent-a', catalog)).size).toBe(4);
    await catalog.update('acme', { status: 'hidden' });
    expect((await offered(store, 'agent-a', catalog)).size).toBe(4);
    await catalog.retire('acme');
    expect((await offered(store, 'agent-a', catalog)).size).toBe(0);
    await catalog.update('acme', { status: 'listed' });
    expect((await offered(store, 'agent-a', catalog)).size).toBe(4);
  });
});

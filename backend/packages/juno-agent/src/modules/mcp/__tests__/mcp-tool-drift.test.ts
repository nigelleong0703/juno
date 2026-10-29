// Tool-list drift (BACKEND 10.18.1): the first list of an app is what the owner accepted; a tool that appears later, or whose annotations
// change, is a change that asks first and is flagged for review; a tool that disappears leaves the plugin's per-tool permissions. A stdio
// bridge stands in for the server so the test controls the list between two sessions.
import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-desktop/public-contracts';
import { createMemoryStore } from '../../../testing/store.js';
import type { Store } from '../../../contracts/index.js';
import { createConnectorCatalog } from '../catalog.js';
import { createMcpManager, markToolsReviewed, type SandboxStdioBridge, type SandboxStdioChannel } from '../index.js';
import { setAgentApp } from '../../apps/agent-apps.js';
import { NOW, isRecord } from './mcp-runtime.fixtures.js';

const OWNER = 'owner-a';
type Listed = { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> };

/** A server whose current tool list the test sets between sessions. */
function server(tools: { current: Listed[] }): SandboxStdioBridge {
  return {
    async open(): Promise<SandboxStdioChannel> {
      let handler: ((line: string) => void) | undefined;
      return {
        send(line: string): void {
          const parsed: unknown = JSON.parse(line);
          if (!isRecord(parsed)) return;
          const id = parsed['id'];
          const answer = (result: Record<string, unknown>): void => queueMicrotask(() => handler?.(JSON.stringify({ jsonrpc: '2.0', id, result })));
          if (parsed['method'] === 'initialize') answer({ protocolVersion: '2024-11-05', serverInfo: { name: 'things', version: '1' } });
          else if (parsed['method'] === 'tools/list') answer({ tools: tools.current });
          else if (parsed['method'] === 'server/discover') queueMicrotask(() => handler?.(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })));
        },
        onMessage(next: (line: string) => void): void { handler = next; },
        async close(): Promise<void> {},
      };
    },
  };
}

const agent = (): Agent & { ownerId: string } => ({
  id: 'agent-a', name: 'Agent', handle: 'a', avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 'Test agent', status: 'idle', section: 'Agents', pinned: false,
  lastActivity: NOW, unreadCount: 0, channels: [], macAccess: false, skillIds: [], pluginIds: ['plugin-things'], sharing: { publishedToTeam: false }, createdAt: NOW, updatedAt: NOW, ownerId: OWNER,
});

const entry = { id: 'acme', name: 'Acme', icon: 'x', description: 'Acme things.', category: 'productivity' as const, url: 'https://mcp.acme.test/mcp' };

async function seeded(): Promise<Store> {
  const store = createMemoryStore().forOwner?.(OWNER);
  if (store === undefined) throw new Error('test store is missing forOwner');
  await store.put('agents', agent());
  await store.put('connections', { id: 'con-acme', kind: 'mcp', name: 'Acme', status: 'disconnected', endpoint: 'things-server', ownerId: OWNER, enabled: true, transport: 'stdio', args: [], catalogId: 'acme', pluginId: 'plugin-things' } as never);
  await store.put('plugins', { id: 'plugin-things', name: 'Things', tools: [{ id: 't1', name: 'create_thing', permission: 'always' }, { id: 't2', name: 'wipe', permission: 'ask' }] } as never);
  return store;
}

const READ_LIST = { name: 'list_things', annotations: { readOnlyHint: true } };
const CREATE = { name: 'create_thing' };

describe('a tool list that drifts after the owner accepted it', () => {
  const tools = { current: [READ_LIST, CREATE] as Listed[] };
  const catalog = createConnectorCatalog([entry]);
  // Each call is a fresh manager (a new session, a fresh list) over the same store, as the next run would be.
  const offered = async (store: Store) => new Map((await createMcpManager({ stdioForAgent: () => server(tools), catalog }).toolsForAgent({ ownerId: OWNER, store, agentId: 'agent-a' })).map((tool) => [tool.origin?.toolName ?? tool.name, tool] as const));

  it('the first list is the baseline; a new tool is a change that asks first even under Allow, and is flagged until reviewed', async () => {
    tools.current = [READ_LIST, CREATE];
    const store = await seeded();
    await setAgentApp(store, { ownerId: OWNER, agentId: 'agent-a', appId: 'acme', actionsPolicy: 'allow' });
    const first = await offered(store);
    expect([...first].map(([name, tool]) => [name, tool.origin?.access, tool.origin?.needsReview])).toEqual([['list_things', 'read', undefined], ['create_thing', 'action', undefined]]);
    expect(first.get('create_thing')?.origin?.actions).toBe('allow');

    // The server now offers a new tool that says it only reads: it is never silently a read.
    tools.current = [READ_LIST, CREATE, { name: 'export_all', annotations: { readOnlyHint: true } }];
    const drifted = await offered(store);
    expect(drifted.get('export_all')?.origin).toMatchObject({ access: 'action', needsReview: true });
    expect(drifted.get('export_all')?.origin?.actions).toBeUndefined();
    expect(drifted.get('export_all')?.sideEffect).toBe(true);
    // The tools the owner saw keep their class and their policy.
    expect(drifted.get('list_things')?.origin).toMatchObject({ access: 'read' });
    expect(drifted.get('create_thing')?.origin).toMatchObject({ access: 'action', actions: 'allow' });
    expect(drifted.get('create_thing')?.origin?.needsReview).toBeUndefined();

    // The Apps page's capability list says so, and reviewing puts the tool back under the normal rules (here: it reads).
    const manager = createMcpManager({ stdioForAgent: () => server(tools), catalog });
    expect((await manager.listTools({ ownerId: OWNER, store, connectionId: 'con-acme' })).find((tool) => tool.name === 'export_all')).toMatchObject({ access: 'action', needsReview: true });
    expect(await markToolsReviewed(store, 'con-acme', ['export_all'])).toEqual(['export_all']);
    expect(await markToolsReviewed(store, 'con-acme')).toEqual([]);
    expect((await offered(store)).get('export_all')?.origin).toMatchObject({ access: 'read' });
  });

  it('changed annotations flag a tool again, even one the owner reviewed; a changed title does not', async () => {
    tools.current = [READ_LIST, CREATE];
    const store = await seeded();
    await offered(store);
    tools.current = [{ name: 'list_things', annotations: { readOnlyHint: true, title: 'Things' } }, CREATE];
    expect((await offered(store)).get('list_things')?.origin).toMatchObject({ access: 'read' });
    tools.current = [{ name: 'list_things', annotations: { readOnlyHint: false } }, CREATE];
    expect((await offered(store)).get('list_things')?.origin).toMatchObject({ access: 'action', needsReview: true });
    // Flipping back is also a change to look at; nothing is trusted by default after a drift.
    await markToolsReviewed(store, 'con-acme');
    tools.current = [READ_LIST, CREATE];
    expect((await offered(store)).get('list_things')?.origin).toMatchObject({ access: 'action', needsReview: true });
  });

  it('a changed input schema flags the tool; the same schema in another key order, or a new description, does not', async () => {
    const schema = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } };
    tools.current = [{ ...READ_LIST, inputSchema: schema }, CREATE];
    const store = await seeded();
    await offered(store);
    tools.current = [{ ...READ_LIST, description: 'now documented', inputSchema: { properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object' } }, CREATE];
    expect((await offered(store)).get('list_things')?.origin).toMatchObject({ access: 'read' });
    tools.current = [{ ...READ_LIST, inputSchema: { ...schema, properties: { ...schema.properties, everything: { type: 'boolean' } } } }, CREATE];
    expect((await offered(store)).get('list_things')?.origin).toMatchObject({ access: 'action', needsReview: true });
  });

  it('a tool our own table names, or that appears in an app we mark read-only, is judged by that table; an unnamed new tool in a read-only app is still held', async () => {
    tools.current = [READ_LIST, CREATE];
    const store = await seeded();
    const curated = createConnectorCatalog([{ ...entry, readOnly: true, toolAccess: { fresh_read: 'read' } }]);
    const seen = async () => new Map((await createMcpManager({ stdioForAgent: () => server(tools), catalog: curated }).toolsForAgent({ ownerId: OWNER, store, agentId: 'agent-a' })).map((tool) => [tool.origin?.toolName ?? tool.name, tool] as const));
    expect((await seen()).get('create_thing')?.origin?.access).toBe('read');
    tools.current = [READ_LIST, CREATE, { name: 'fresh_read' }, { name: 'surprise' }];
    const after = await seen();
    expect(after.get('fresh_read')?.origin).toMatchObject({ access: 'read' });
    expect(after.get('surprise')?.origin).toMatchObject({ access: 'action', needsReview: true });
  });

  it('a tool that disappears leaves the ledger and the plugin\'s per-tool permissions; the others keep theirs', async () => {
    tools.current = [READ_LIST, CREATE, { name: 'wipe' }];
    const store = await seeded();
    await offered(store);
    tools.current = [READ_LIST, { name: 'wipe' }];
    await offered(store);
    expect((await store.get('plugins', 'plugin-things'))?.tools.map((tool) => [tool.name, tool.permission])).toEqual([['wipe', 'ask']]);
    // It comes back as a new tool: its old "always allow" is not waiting for it.
    tools.current = [READ_LIST, CREATE, { name: 'wipe' }];
    expect((await offered(store)).get('create_thing')?.origin).toMatchObject({ access: 'action', needsReview: true });
  });
});

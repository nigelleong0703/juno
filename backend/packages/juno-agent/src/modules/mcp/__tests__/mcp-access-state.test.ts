// The access state at the MCP manager (BACKEND 10.18.1): a refused or rejected call comes back as the one sentence of the state, with the
// state beside it, and the connection row keeps what the provider said (so the Connect card and a later call agree).
import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-desktop/public-contracts';
import { createMemoryStore } from '../../../testing/store.js';
import type { Store, ToolContext } from '../../../contracts/index.js';
import { appAccess, agentAppSettings, setAgentApp } from '../../apps/agent-apps.js';
import { AppAccessError, createMcpManager } from '../index.js';
import { NOW, isRecord, toolContext } from './mcp-runtime.fixtures.js';

const OWNER = 'owner-a';
const URL_ = 'https://mcp.acme.test/mcp';

/** A remote server whose tools/call answers with whatever `call` says: a status and, for a 403, the WWW-Authenticate challenge. */
function acmeFetch(call: { status: number; challenge?: string }): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const message: unknown = JSON.parse(String(init?.body ?? '{}'));
    const method = isRecord(message) ? message['method'] : undefined;
    const id = isRecord(message) ? message['id'] : undefined;
    const rpc = (result: Record<string, unknown>) => Response.json({ jsonrpc: '2.0', id, result });
    if (method === 'server/discover') return new Response(null, { status: 404 });
    if (method === 'initialize') return rpc({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'acme', version: '1' } });
    if (method === 'tools/list') return rpc({ tools: [{ name: 'list_events', annotations: { readOnlyHint: true } }, { name: 'create_event' }] });
    if (method === 'tools/call') {
      return new Response(null, { status: call.status, headers: call.challenge === undefined ? {} : { 'www-authenticate': call.challenge } });
    }
    return new Response(null, { status: 202 });
  }) as typeof fetch;
}

async function seeded(): Promise<Store> {
  const store = createMemoryStore().forOwner?.(OWNER);
  if (store === undefined) throw new Error('test store is missing forOwner');
  const agent: Agent & { ownerId: string } = {
    id: 'agent-a', name: 'Agent', handle: 'a', avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 'Test agent', status: 'idle', section: 'Agents', pinned: false,
    lastActivity: NOW, unreadCount: 0, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdAt: NOW, updatedAt: NOW, ownerId: OWNER,
  };
  await store.put('agents', agent);
  await store.put('connections', { id: 'con-acme', kind: 'mcp', name: 'Acme Calendar', status: 'connected', connectedAt: NOW, endpoint: URL_, ownerId: OWNER, enabled: true, transport: 'http', catalogId: 'acme' } as never);
  return store;
}

async function run(store: Store, call: { status: number; challenge?: string }, toolName = 'create_event') {
  const manager = createMcpManager({ fetchImpl: acmeFetch(call) });
  const tool = (await manager.toolsForAgent({ ownerId: OWNER, store, agentId: 'agent-a' })).find((candidate) => candidate.origin?.toolName === toolName);
  const ctx: ToolContext = { ...toolContext(), store, agentId: 'agent-a' };
  return { result: await tool?.execute({}, ctx), manager };
}

describe('the access state a refused call comes back with', () => {
  it('a rejected sign-in is expired: one sentence to reconnect, no retry, and the row stops reading as connected', async () => {
    const store = await seeded();
    const { result } = await run(store, { status: 401, challenge: 'Bearer error="invalid_token"' });
    expect(result).toMatchObject({ isError: true, details: { access: { appId: 'acme', state: 'expired' } }, content: [{ text: expect.stringMatching(/Acme Calendar's sign-in expired.*reconnect Acme Calendar.*connect_request.*Do not retry/) }] });
    const connections = (await store.list('connections', { limit: 10 })).items;
    expect(appAccess(connections, await agentAppSettings(store, 'agent-a'), 'acme').state).toBe('expired');
  });

  it('a 403 insufficient_scope is scope_missing and names the permission; the Connect card state agrees afterwards', async () => {
    const store = await seeded();
    const { result } = await run(store, { status: 403, challenge: 'Bearer error="insufficient_scope", scope="calendar.write"' });
    expect(result).toMatchObject({ isError: true, details: { access: { appId: 'acme', state: 'scope_missing', scope: 'calendar.write' } }, content: [{ text: expect.stringContaining('lacks a permission (calendar.write)') }] });
    const connections = (await store.list('connections', { limit: 10 })).items;
    expect(appAccess(connections, await agentAppSettings(store, 'agent-a'), 'acme')).toEqual({ appId: 'acme', state: 'scope_missing', scope: 'calendar.write' });
  });

  it('turned off for the agent, or Actions off, is told by the same sentences even when the agent still holds the tool', async () => {
    const store = await seeded();
    const manager = createMcpManager({ fetchImpl: acmeFetch({ status: 200 }) });
    await setAgentApp(store, { ownerId: OWNER, agentId: 'agent-a', appId: 'acme', actionsPolicy: 'off' });
    const call = (toolName: string) => manager.callTool({ ownerId: OWNER, store, agentId: 'agent-a', connectionId: 'con-acme', toolName, args: {} });
    await expect(call('create_event')).rejects.toMatchObject({ access: { appId: 'acme', state: 'not_granted' }, message: expect.stringMatching(/create_event changes things in Acme Calendar, and Actions is off/) });
    await setAgentApp(store, { ownerId: OWNER, agentId: 'agent-a', appId: 'acme', enabled: false });
    const refused: unknown = await call('list_events').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AppAccessError);
    expect((refused as AppAccessError).access.state).toBe('not_enabled');
  });
});

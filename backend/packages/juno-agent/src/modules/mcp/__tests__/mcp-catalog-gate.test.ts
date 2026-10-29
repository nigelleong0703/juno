// A stored connection to a catalog connector the deployment no longer offers (its plugin is off) is not used; a custom server and an offered connector are.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import type { Store } from '../../../contracts/index.js';
import type { Agent } from '@agent-desktop/public-contracts';
import { createMcpManager } from '../index.js';
import { createConnectorCatalog, type CatalogEntry } from '../catalog.js';
import { NOW, startFixture, type Fixture } from './mcp-runtime.fixtures.js';

const OWNER = 'owner-a';
const AGENT = 'agent-a';

const agent: Agent & { ownerId: string } = {
  id: AGENT, name: 'Agent', handle: AGENT, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 'Test agent', status: 'idle', section: 'Agents', pinned: false,
  lastActivity: NOW, unreadCount: 0, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdAt: NOW, updatedAt: NOW, ownerId: OWNER,
};

const offered: CatalogEntry = { id: 'fixture-calendar', name: 'Fixture Calendar', icon: 'calendar', description: 'Fixture', category: 'productivity', url: 'https://mcp.fixture.test/mcp' };

describe('the MCP manager follows the connector catalog', () => {
  let fixture: Fixture;
  let previousPrivateHosts: string | undefined;
  beforeAll(async () => {
    previousPrivateHosts = process.env.MCP_ALLOW_PRIVATE_HOSTS;
    process.env.MCP_ALLOW_PRIVATE_HOSTS = '1';
    fixture = await startFixture();
  });
  afterAll(async () => {
    await fixture.close();
    if (previousPrivateHosts === undefined) delete process.env.MCP_ALLOW_PRIVATE_HOSTS;
    else process.env.MCP_ALLOW_PRIVATE_HOSTS = previousPrivateHosts;
  });

  async function seeded(): Promise<Store> {
    const scoped = createMemoryStore().forOwner?.(OWNER);
    if (!scoped) throw new Error('test store is missing forOwner');
    await scoped.put('agents', agent);
    const base = { kind: 'mcp' as const, status: 'disconnected' as const, endpoint: fixture.url, ownerId: OWNER, enabled: true, transport: 'http' as const };
    await scoped.put('connections', { ...base, id: 'con-offered', name: 'Offered', catalogId: 'fixture-calendar' });
    await scoped.put('connections', { ...base, id: 'con-removed', name: 'Removed', catalogId: 'removed-by-plugin' });
    await scoped.put('connections', { ...base, id: 'con-custom', name: 'Custom' });
    return scoped;
  }

  it('lists tools only for offered and custom connections, and refuses a call on a removed one with a clear error', async () => {
    const store = await seeded();
    // The same fixture server sits behind all three rows, so each connection contributes the same number of tools.
    const everything = createMcpManager();
    const ungated = await everything.toolsForAgent({ ownerId: OWNER, store, agentId: AGENT });
    const manager = createMcpManager({ catalog: createConnectorCatalog([offered]) });
    const gated = await manager.toolsForAgent({ ownerId: OWNER, store, agentId: AGENT });
    expect(ungated.length).toBeGreaterThan(0);
    expect(gated.length * 3).toBe(ungated.length * 2);
    await expect(manager.callTool({ ownerId: OWNER, store, agentId: AGENT, connectionId: 'con-removed', toolName: 'whatever', args: {} }))
      .rejects.toThrow('connector "removed-by-plugin" is not available on this deployment');
    await manager.close();
    await everything.close();
  });
});

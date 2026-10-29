// PH7 composition: the real tool registry assembly (not a test-only helper) serves and executes a
// real MCP tool over the HTTP fixture, inside the trusted owner scope, and drops it after disconnect.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { Store, ToolContext } from '../../../contracts/index.js';
import type { Agent } from '@agent-desktop/public-contracts';
import { createToolRegistry } from '../../../modules/tools/index.js';
import { runWithOwner } from '../../../owner-context.js';
import { createMcpManager, mcpToolName } from '../index.js';
import { NOW, startFixture, toolContext, type Fixture } from './mcp-runtime.fixtures.js';

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
}

function agentDoc(): Agent & { ownerId: string } {
  return {
    id: AGENT,
    name: 'Agent ' + AGENT,
    handle: AGENT,
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
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdAt: NOW,
    updatedAt: NOW,
    ownerId: OWNER,
  };
}

async function seed(url: string): Promise<Store> {
  const store = createMemoryStore();
  const scoped = store.forOwner?.(OWNER);
  if (!scoped) throw new Error('test store is missing forOwner');
  await scoped.put('agents', agentDoc());
  const connection: SeedConnection = { id: 'con-1', kind: 'mcp', name: 'Fixture Server', status: 'disconnected', endpoint: url, ownerId: OWNER, enabled: true, transport: 'http' };
  await scoped.put('connections', connection);
  return scoped;
}

function mcpNames(registry: { forAgent(agentId: string): Promise<Array<{ name: string; mcp?: true }>> }, agentId: string): Promise<string[]> {
  return runWithOwner(OWNER, async () =>
    (await registry.forAgent(agentId)).filter((tool) => tool.mcp === true).map((tool) => tool.name),
  );
}

describe('PH7 production composition', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await startFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it('serves and executes a real MCP tool through the actual tool registry assembly', async () => {
    const scoped = await seed(fixture.url);
    const registry = await createToolRegistry({
      store: scoped,
      enqueuer: new NoopEnqueuer(),
            mcp: createMcpManager(),
    });
    const names = await mcpNames(registry, AGENT);
    expect(names).toHaveLength(8);
    const tool = registry.get(mcpToolName('fixture_server', 'echo'));
    expect(tool).toBeDefined();
    const ctx: ToolContext = { ...toolContext(), store: scoped, agentId: AGENT };
    const result = await runWithOwner(OWNER, () => tool?.execute({ text: 'composed' }, ctx));
    expect(JSON.stringify(result?.content)).toContain('echo:composed');
    // The call really crossed HTTP: the fixture saw the negotiated protocol version.
    expect(fixture.state.protocolVersions.length).toBeGreaterThan(0);
  });

  it('carries server usage instructions through the production registry', async () => {
    fixture.state.instructions = 'Before creating a page, search for an existing one.';
    const manager = createMcpManager();
    try {
      const scoped = await seed(fixture.url);
      const registry = await createToolRegistry({ store: scoped, enqueuer: new NoopEnqueuer(), mcp: manager });
      const tools = await runWithOwner(OWNER, () => registry.forAgent(AGENT));
      const tool = tools.find((candidate) => candidate.name === mcpToolName('fixture_server', 'echo'));
      expect(tool?.description).toContain(fixture.state.instructions);
      expect(tool?.description).toContain('Echo the text');
    } finally {
      delete fixture.state.instructions;
      await manager.close();
    }
  });

  it('drops the tool from the assembly once the user disconnects the server', async () => {
    const scoped = await seed(fixture.url);
    const manager = createMcpManager();
    const registry = await createToolRegistry({
      store: scoped,
      enqueuer: new NoopEnqueuer(),
            mcp: manager,
    });
    const name = mcpToolName('fixture_server', 'echo');
    await runWithOwner(OWNER, () => manager.disconnect({ store: scoped, connectionId: 'con-1' }));
    expect(await mcpNames(registry, AGENT)).toHaveLength(0);
    const cached = registry.get(name);
    const ctx: ToolContext = { ...toolContext(), store: scoped, agentId: AGENT };
    const refused = await runWithOwner(OWNER, () => cached?.execute({}, ctx));
    expect(refused?.isError).toBe(true);
  });
});

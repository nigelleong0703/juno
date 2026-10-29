// MCP initialize.instructions delivery: live-client lifecycle, bounded labelled
// model-facing guidance, and tool_search best-match carry-through.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import type { Store, Tool, ToolContext } from '../../../contracts/index.js';
import type { Agent } from '@agent-desktop/public-contracts';
import { createMcpClient, createMcpManager, createMcpTool, mcpToolName } from '../index.js';
import { MAX_SERVER_INSTRUCTIONS_CHARS } from '../registry.js';
import { createToolSearchTool, MAX_BEST_DESCRIPTION_CHARS } from '../../../modules/tools/tools/toolSearch.js';
import { runWithOwner } from '../../../owner-context.js';
import { NOW, startFixture, toolContext, type Fixture } from './mcp-runtime.fixtures.js';

const OWNER = 'owner-a';
const AGENT = 'agent-a';

let previousPrivateHosts: string | undefined;
let fixture: Fixture;

beforeAll(async () => {
  previousPrivateHosts = process.env.MCP_ALLOW_PRIVATE_HOSTS;
  process.env.MCP_ALLOW_PRIVATE_HOSTS = '1';
  fixture = await startFixture();
});

afterAll(async () => {
  await fixture?.close();
  if (previousPrivateHosts === undefined) delete process.env.MCP_ALLOW_PRIVATE_HOSTS;
  else process.env.MCP_ALLOW_PRIVATE_HOSTS = previousPrivateHosts;
});

function agentDoc(): Agent & { ownerId: string } {
  return {
    id: AGENT, name: 'Agent ' + AGENT, handle: AGENT,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 'Test agent',
    status: 'idle', section: 'Agents', pinned: false, lastActivity: NOW,
    unreadCount: 0, channels: [], macAccess: false, skillIds: [], pluginIds: [],
    sharing: { publishedToTeam: false }, createdAt: NOW, updatedAt: NOW, ownerId: OWNER,
  };
}

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

async function seeded(url: string, id = 'con-1'): Promise<Store> {
  const store = createMemoryStore();
  const scoped = store.forOwner?.(OWNER);
  if (!scoped) throw new Error('test store is missing forOwner');
  await scoped.put('agents', agentDoc());
  const connection: SeedConnection = {
    id, kind: 'mcp', name: 'Fixture Server', status: 'disconnected',
    endpoint: url, ownerId: OWNER, enabled: true, transport: 'http',
  };
  await scoped.put('connections', connection);
  return scoped;
}

function boundTool(serverInstructions?: string, description = 'Echo the text'): Tool {
  return createMcpTool({
    ownerId: OWNER, agentId: AGENT, connectionId: 'con-1', connectionName: 'Fixture Server',
    name: 'fixture_server_echo', tool: { name: 'echo', description }, catalogTruncated: false, access: 'action',
    manager: createMcpManager(),
    ...(serverInstructions === undefined ? {} : { serverInstructions }),
  });
}

function fakeTool(name: string, description: string): Tool {
  return {
    name, description, parameters: { type: 'object', properties: { q: { type: 'string' } } },
    replay: 'safe', sideEffect: false,
    async execute() { return { content: [{ type: 'text', text: '' }] }; },
  };
}

describe('MCP initialize.instructions delivery', () => {
  it('preserves live instructions and clears them on close', async () => {
    fixture.state.instructions = 'Search first, then create.';
    const client = createMcpClient({ transport: 'http', url: fixture.url });
    try {
      await client.connect();
      expect(client.serverInstructions()).toBe('Search first, then create.');
      await client.close();
      expect(client.serverInstructions()).toBeUndefined();
    } finally {
      delete fixture.state.instructions;
      await client.close().catch(() => undefined);
    }
  });

  it('clears stale guidance on reconnect and on failed connects', async () => {
    fixture.state.instructions = 'First guidance.';
    const client = createMcpClient({ transport: 'http', url: fixture.url });
    try {
      await client.connect();
      expect(client.serverInstructions()).toBe('First guidance.');
      delete fixture.state.instructions;
      await client.reconnect();
      expect(client.serverInstructions()).toBeUndefined();
    } finally {
      delete fixture.state.instructions;
      await client.close().catch(() => undefined);
    }
    const broken = createMcpClient({ transport: 'http', url: fixture.authUrl });
    await expect(broken.connect()).rejects.toBeTruthy();
    expect(broken.serverInstructions()).toBeUndefined();
    await broken.close().catch(() => undefined);
  });

  it('keeps missing or blank instructions out of the description', () => {
    expect(boundTool(undefined).description).toBe('Echo the text');
    expect(boundTool('   ').description).toBe('Echo the text');
    expect(boundTool('').description).toBe('Echo the text');
  });

  it('appends guidance under a source label and bounds each side separately', () => {
    const tool = boundTool('Search before creating.', 'Echo the text');
    expect(tool.description).toContain('Echo the text');
    expect(tool.description).toContain('Server usage guidance: Search before creating.');
    const longBase = 'D'.repeat(2000);
    const longGuidance = 'G'.repeat(MAX_SERVER_INSTRUCTIONS_CHARS + 100);
    const bounded = boundTool(longGuidance, longBase);
    expect(bounded.description).toContain('Server usage guidance: ');
    // Both sides are bounded: the output is far shorter than the unbounded concatenation.
    expect(bounded.description.length).toBeLessThan(longBase.length + longGuidance.length);
    // The tool text still leads, so a long description never swallows the guidance.
    expect(bounded.description.startsWith('D'.repeat(500))).toBe(true);
    expect(bounded.replay).toBe('never');
    expect(bounded.sideEffect).toBe(true);
  });

  it('carries guidance through the production manager without leaking across sessions', async () => {
    fixture.state.instructions = 'Prefer search before create.';
    const manager = createMcpManager();
    try {
      const scoped = await seeded(fixture.url);
      const withGuidance = await runWithOwner(OWNER, () => manager.toolsForAgent({ store: scoped, agentId: AGENT }));
      const echo = withGuidance.find((tool) => tool.name === mcpToolName('fixture_server', 'echo'));
      expect(echo?.description).toContain('Prefer search before create.');
      expect(echo?.description).toContain('Server usage guidance:');
      expect(echo?.description).toContain('Echo the text');
      await manager.close();
      delete fixture.state.instructions;
      const fresh = createMcpManager();
      try {
        const scoped2 = await seeded(fixture.url);
        const without = await runWithOwner(OWNER, () => fresh.toolsForAgent({ store: scoped2, agentId: AGENT }));
        const echo2 = without.find((tool) => tool.name === mcpToolName('fixture_server', 'echo'));
        expect(echo2?.description).toBe('Echo the text');
      } finally {
        await fresh.close();
      }
    } finally {
      delete fixture.state.instructions;
      await manager.close();
    }
  });

  it('tool_search best match carries guidance past the 200-char summary cut, with schema', async () => {
    const marker = 'SECRET-GUIDANCE-MARKER-9f3c';
    const longDescription = 'Echo the text. ' + 'filler '.repeat(60) + 'Server usage guidance: ' + marker;
    expect(longDescription.indexOf(marker)).toBeGreaterThan(200);
    const search = createToolSearchTool({
      all: async () => [fakeTool('fixture_server_echo', longDescription)],
      visible: async () => new Set<string>(),
    });
    const ctx: ToolContext = { ...toolContext(), store: createMemoryStore(), agentId: AGENT };
    const result = await runWithOwner(OWNER, () => search.execute({ query: 'echo' }, ctx));
    const text = JSON.stringify(result.content);
    expect(text).toContain(marker);
    expect(text).toContain('schema:');
  });

  it('tool_search keeps other matches as summaries and caps an unbounded best match', async () => {
    const second = fakeTool('other_tool_echo', 'x'.repeat(500) + ' echo');
    const huge = fakeTool('fixture_server_echo', 'Y'.repeat(5000) + ' echo');
    const search = createToolSearchTool({
      all: async () => [huge, second],
      visible: async () => new Set<string>(),
    });
    const ctx: ToolContext = { ...toolContext(), store: createMemoryStore(), agentId: AGENT };
    const result = await runWithOwner(OWNER, () => search.execute({ query: 'echo' }, ctx));
    const text = JSON.stringify(result.content);
    expect(text).toContain('other_tool_echo');
    // The best match is capped at its bound plus head/schema metadata; the rest stay 200-char summaries.
    expect(text.length).toBeLessThanOrEqual(MAX_BEST_DESCRIPTION_CHARS + 1500);
    expect(text).not.toContain('Y'.repeat(5000));
    expect(text).not.toContain('x'.repeat(201));
  });
});

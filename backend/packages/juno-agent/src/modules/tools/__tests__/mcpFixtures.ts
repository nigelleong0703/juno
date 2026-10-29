/** Scaffolding for the MCP registry tests: real servers, owner-scoped store and tool-context helpers. */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryStore } from '../../../testing/store.js';
import type { Store, ToolContext, ToolRegistry, WakeEvent } from '../../../contracts/index.js';
import type { Agent } from '@agent-desktop/public-contracts';
import type { StoredMcpConnection } from '../../mcp/connections.js';
import { NoopEnqueuer } from './codingFixtures.js';

export const MCP_OWNER = 'owner-1';

/** The run's store is owner-scoped in production, so tests seed and drive through the owner scope. */
export function scopedStore(ownerId = MCP_OWNER): Store {
  const scoped = createMemoryStore().forOwner?.(ownerId);
  if (scoped === undefined) throw new Error('memory store must support forOwner');
  return scoped;
}

export function mcpAgent(id: string, pluginIds: string[]): Agent {
  return {
    id, name: id, handle: id, avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'tester', status: 'idle', section: 'Work', pinned: false, lastActivity: '',
    unreadCount: 0,
    model: { planner: { provider: 'scripted', model: 't' }, computer: { provider: 'scripted', model: 't' }, fast: { provider: 'scripted', model: 't' } },
    channels: [], macAccess: false, skillIds: [], pluginIds,
    sharing: { publishedToTeam: false }, createdBy: MCP_OWNER,
    createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
  };
}

export function mcpConnection(input: { id: string; name: string; url?: string; command?: string; args?: string[]; pluginId: string }): StoredMcpConnection {
  return {
    id: input.id, kind: 'mcp', name: input.name, status: 'disconnected', ownerId: MCP_OWNER, enabled: true,
    pluginId: input.pluginId,
    endpoint: input.url ?? input.command,
    transport: input.url === undefined ? 'stdio' : 'http',
    ...(input.args === undefined ? {} : { args: input.args }),
  };
}

const wake: WakeEvent = {
  id: 'w', ownerId: MCP_OWNER, agentId: 'agent-a', sessionKey: 's', conversationId: 'c', kind: 'user_message',
  origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, at: '2026-10-08T00:00:00.000Z',
} as WakeEvent;

export function mcpCtx(store: Store, agentId: string): ToolContext {
  return { ownerId: MCP_OWNER, agentId, conversationId: 'c', runId: 'r', store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), wake, step: async (_name, fn) => fn(), signal: new AbortController().signal };
}

export async function mcpNames(registry: ToolRegistry, agentId: string): Promise<string[]> {
  const tools = await registry.forAgent(agentId);
  return tools.filter((tool) => tool.mcp === true).map((tool) => tool.name);
}

export interface McpHttpServer {
  url: string;
  calls: string[];
  lastArgs: () => Record<string, unknown>;
  close: () => Promise<void>;
}

/** A real streamable-HTTP MCP server: one POST per JSON-RPC message, a JSON response body. */
export async function startMcpHttpServer(serverName = 'fake-http', toolName = 'echo', hang = false): Promise<McpHttpServer> {
  const calls: string[] = [];
  let lastArgs: Record<string, unknown> = {};
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      // A hanging server never answers, so discovery can only end by cancellation.
      if (hang) return;
      const frame = body === '' ? {} : JSON.parse(body);
      calls.push(String(frame.method));
      const reply = (result: unknown) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }));
      };
      if (frame.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: serverName, version: '1.0.0' } });
      else if (frame.method === 'tools/list') reply({ tools: [{ name: toolName, description: 'echo back', inputSchema: { type: 'object', properties: {} } }] });
      else if (frame.method === 'tools/call') {
        lastArgs = (frame.params?.arguments ?? {}) as Record<string, unknown>;
        reply({ content: [{ type: 'text', text: serverName + ':' + JSON.stringify(lastArgs) }] });
      } else if (frame.id === undefined) {
        response.writeHead(202);
        response.end();
      } else reply({ content: [] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: 'http://127.0.0.1:' + String(port) + '/mcp',
    calls,
    lastArgs: () => lastArgs,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

const SERVER_LINES = [
  "process.stdin.setEncoding('utf8');",
  "process.stderr.write('mcp-stdio-server: started\\n');",
  "function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: id, result: result }) + '\\n'); }",
  "function handle(line) {",
  "  var frame; try { frame = JSON.parse(line); } catch (error) { return; }",
  "  if (frame.id === undefined) { return; }",
  "  if (frame.method === 'initialize') { process.stderr.write('diag: initialize\\n'); reply(frame.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-stdio', version: '1.0.0' } }); }",
  "  else if (frame.method === 'tools/list') { process.stderr.write('diag: tools/list\\n'); reply(frame.id, { tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: {} } }] }); }",
  "  else if (frame.method === 'tools/call') { reply(frame.id, { content: [{ type: 'text', text: 'stdio:' + JSON.stringify(frame.params && frame.params.arguments ? frame.params.arguments : {}) }] }); }",
  "  else { reply(frame.id, { content: [] }); }",
  "}",
  "var buffer = '';",
  "process.stdin.on('data', function (chunk) { buffer += chunk; var index; while ((index = buffer.indexOf('\\n')) >= 0) { var line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.trim() !== '') handle(line); } });",
];

/** A real MCP stdio server (newline JSON-RPC on stdout, diagnostics on stderr) as a runnable script. */
export function writeMcpStdioServer(root: string): string {
  const path = join(root, 'mcp-stdio-server.cjs');
  writeFileSync(path, SERVER_LINES.join('\n') + '\n');
  return path;
}

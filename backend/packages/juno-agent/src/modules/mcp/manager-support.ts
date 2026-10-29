// Helpers for the production MCP manager, kept separate so the manager itself stays small: trusted
// owner resolution, per-agent transport construction, plugin denials and bounded discovery connect.
import type { Store, Tool } from '../../contracts/index.js';
import type { Agent, Connection } from '@agent-desktop/public-contracts';
import { currentOwnerId } from '../../owner-context.js';
import type { McpClient } from './client.js';
import { McpConnectionError } from './client.js';
import type { McpServerConfig } from './config.js';
import { connectionStatusFor, isConnectionEnabled, readConnectionOwner, type StoredMcpConnection } from './connections.js';
import { HttpMcpTransport } from './http-transport.js';
import { McpUnsupportedError } from './protocol.js';
import { createMcpTool, isSchemaWithinBound, mcpConnectionPrefixes, mcpToolNames } from './registry.js';
import type { CuratedAccess } from './tool-access.js';
import { classifyReviewed, needsReview, type ToolLedger } from './tool-ledger.js';
import { appIdOfConnection, settingFor, type AgentAppSetting } from '../apps/agent-apps.js';
import { StdioMcpTransport, type SandboxStdioBridge } from './stdio-transport.js';
import type { McpTransport } from './transport.js';
import type { McpConnectionStatus } from './client.js';
import type { McpManager } from './manager.js';

export const DEFAULT_CONCURRENCY = 4;

export interface Session {
  client: McpClient;
  truncated: boolean;
}

export interface McpManagerTransportDeps {
  /** Resolve the sandbox stdio bridge for one agent: a stdio server runs in that agent's computer. */
  stdioForAgent?: (input: { ownerId: string; agentId: string | undefined }) => SandboxStdioBridge | undefined;
  fetchImpl?: typeof fetch;
}

/** Trusted owner: the explicit argument, else the server's request owner scope. Never a doc guess. */
export function resolveOwner(explicit: string | undefined): string {
  const owner = explicit ?? currentOwnerId();
  if (owner === undefined) {
    throw new McpConnectionError('no trusted owner id in scope; pass ownerId or run inside runWithOwner');
  }
  return owner;
}

export function transportFor(
  config: McpServerConfig,
  deps: McpManagerTransportDeps,
  ownerId: string,
  agentId: string | undefined,
  authorize?: () => Promise<string>,
): McpTransport {
  if (config.transport === 'http') {
    return new HttpMcpTransport({
      url: config.url,
      ...(config.headers === undefined ? {} : { headers: config.headers }),
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      ...(authorize === undefined ? {} : { authorize }),
    });
  }
  const bridge = deps.stdioForAgent?.({ ownerId, agentId });
  if (bridge === undefined) {
    throw new McpUnsupportedError('stdio MCP requires a sandbox bridge bound to this agent computer; the host does not spawn processes');
  }
  return new StdioMcpTransport(
    config.env === undefined
      ? { bridge, command: config.command, args: config.args }
      : { bridge, command: config.command, args: config.args, env: config.env },
  );
}

/** Names of the tools an installed plugin marks never; a missing plugin denies nothing here. */
export async function neverTools(store: Store, pluginId: string | undefined): Promise<Set<string>> {
  if (pluginId === undefined) return new Set();
  const plugin = await store.get('plugins', pluginId);
  if (plugin === null) return new Set();
  return new Set(plugin.tools.filter((tool) => tool.permission === 'never').map((tool) => tool.name));
}

/** Start at most `limit` connects at once; cancellation propagates instead of being swallowed. */
export async function connectBounded(
  docs: StoredMcpConnection[],
  limit: number,
  connect: (doc: StoredMcpConnection) => Promise<Session>,
  signal: AbortSignal | undefined,
): Promise<Array<{ doc: StoredMcpConnection; session: Session }>> {
  const out: Array<{ doc: StoredMcpConnection; session: Session }> = [];
  const queue = [...docs];
  const worker = async (): Promise<void> => {
    for (;;) {
      const doc = queue.shift();
      if (doc === undefined) return;
      try {
        const session = await connect(doc);
        out.push({ doc, session });
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
  };
  const workers = Math.min(limit, docs.length);
  if (workers === 0) return out;
  await Promise.all(Array.from({ length: workers }, worker));
  return out;
}

/** The connection is visible in the caller's owner scope and, when it records an owner, it matches. */
export async function loadConnection(store: Store, ownerId: string, connectionId: string): Promise<StoredMcpConnection | null> {
  const doc = await store.get('connections', connectionId);
  if (doc === null || doc.kind !== 'mcp') return null;
  const recorded = readConnectionOwner(doc);
  if (recorded !== undefined && recorded !== ownerId) return null;
  return doc;
}

export async function persistConnection(store: Store, connectionId: string, status: McpConnectionStatus): Promise<void> {
  const patch: Partial<Connection> = { status: connectionStatusFor(status.state) };
  if (status.state === 'connected') patch.connectedAt = new Date().toISOString();
  await store.patch('connections', connectionId, patch);
}

/** Error-path status write: skipped when the row was revoked, so a failure never resurrects it. */
export async function persistIfEnabled(store: Store, ownerId: string, connectionId: string, status: McpConnectionStatus): Promise<void> {
  const fresh = await loadConnection(store, ownerId, connectionId).catch(() => null);
  if (fresh === null || !isConnectionEnabled(fresh)) return;
  await persistConnection(store, connectionId, status).catch(() => undefined);
}

/** The agent must be visible in the caller's owner scope before any MCP catalog or call is allowed. */
export async function authorizeAgent(store: Store, agentId: string): Promise<Agent> {
  const agent = await store.get('agents', agentId);
  if (agent === null) throw new McpConnectionError('agent ' + JSON.stringify(agentId) + ' is not available in this owner scope');
  return agent;
}

/** Abort `controller` as soon as the canonical row is revoked, so a cross-process disconnect lands. */
export function watchRevocation(store: Store, ownerId: string, connectionId: string, controller: AbortController): () => void {
  const timer = setInterval(() => {
    void loadConnection(store, ownerId, connectionId)
      .then((doc) => {
        if (doc === null || !isConnectionEnabled(doc)) controller.abort(new Error('MCP connection was disconnected'));
      })
      .catch(() => undefined);
  }, 250);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** One registry Tool per discovered server tool, bound to the owner/agent and this manager. */
export async function toolsFromSessions(
  store: Store,
  ownerId: string,
  agentId: string,
  manager: McpManager,
  connected: Array<{ doc: StoredMcpConnection; session: Session }>,
  apps: { settings: ReadonlyMap<string, AgentAppSetting>; curatedFor: (doc: StoredMcpConnection) => CuratedAccess | undefined; ledgers: ReadonlyMap<string, ToolLedger> },
): Promise<Tool[]> {
  const tools: Tool[] = [];
  const prefixes = mcpConnectionPrefixes(connected.map(({ doc }) => ({ id: doc.id, name: doc.name, ...(doc.catalogId === undefined ? {} : { catalogId: doc.catalogId }), ...(doc.account === undefined ? {} : { account: doc.account }) })));
  for (const { doc, session } of connected) {
    const denied = await neverTools(store, doc.pluginId);
    const setting = settingFor(apps.settings, appIdOfConnection(doc));
    const curated = apps.curatedFor(doc);
    const advertised = session.client.discoveredTools();
    // Live initialize.instructions for this owner/agent/connection session; never shared across sessions.
    const serverInstructions = session.client.serverInstructions();
    const names = mcpToolNames(prefixes.get(doc.id) ?? 'mcp', advertised.map((tool) => tool.name));
    for (const tool of advertised) {
      if (denied.has(tool.name)) continue;
      // An app whose Actions policy is Off for this agent never advertises a tool that changes things.
      const ledger = apps.ledgers.get(doc.id);
      const access = classifyReviewed(tool, curated, ledger);
      if (access === 'action' && setting.actionsPolicy === 'off') continue;
      // A schema we cannot carry is not advertised at all, rather than a permissive fake one.
      if (!isSchemaWithinBound(tool)) continue;
      // A tool the owner has not reviewed asks first whatever the app's policy says (the Allow policy covers the tools the owner saw).
      const unreviewed = needsReview(ledger, tool.name);
      tools.push(createMcpTool({ ownerId, agentId, connectionId: doc.id, connectionName: doc.name, name: names.get(tool.name) ?? tool.name, tool, catalogTruncated: session.client.toolsTruncated(), manager, access, ...(unreviewed ? { needsReview: true as const } : {}), ...(setting.actionsPolicy === 'allow' && !unreviewed ? { actions: 'allow' as const } : {}), ...(doc.catalogId === undefined ? {} : { catalogId: doc.catalogId }), ...(doc.account === undefined ? {} : { account: doc.account }), ...(serverInstructions === undefined ? {} : { serverInstructions }) }));
    }
  }
  return tools;
}

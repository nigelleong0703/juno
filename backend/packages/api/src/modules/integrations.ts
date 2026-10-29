/**
 * Integrations module: the plugin catalog, and the row a custom MCP server is added as (Apps, modules/connectors.ts). A
 * configured MCP server is recorded as disconnected because no live MCP session exists yet.
 *
 * A stdio server's env values are the only secrets stored here: they are encrypted before the write
 * (H-50) and every connection returned to a client is parsed through the public schema, which drops
 * the stored `env` along with the other private fields.
 */
import { randomUUID } from 'node:crypto';
import type { ListPage, ListQuery, Store } from '@agent-desktop/contracts';
import { NotFoundError } from '@agent-desktop/contracts';
import type {
  Connection,
  CreateMcpServerInput,
  Plugin,
  ToolPermission,
} from '@agent-desktop/public-contracts';
import { connectionSchema } from '@agent-desktop/public-contracts';
import { encryptSecret } from '@agent-desktop/contracts/secrets';
import { mcpUrlRefused } from '@agent-desktop/contracts/mcp';

export interface IntegrationsModule {
  listPlugins(query: ListQuery): Promise<ListPage<Plugin>>;
  getPlugin(id: string): Promise<Plugin | null>;
  setPluginInstalled(id: string, installed: boolean): Promise<Plugin>;
  setToolPermission(pluginId: string, toolId: string, permission: ToolPermission): Promise<Plugin>;
  createMcpConnection(input: CreateMcpServerInput): Promise<Connection>;
}

/** A configuration problem the route reports as 400 instead of silently dropping input. */
export class McpConfigError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'McpConfigError';
  }
}

export interface McpServerTarget {
  transport: 'http' | 'stdio';
  endpoint: string;
}

interface StoredConnection extends Connection {
  ownerId?: string;
  transport?: 'http' | 'stdio';
  args?: string[];
  /** Encrypted at rest (`enc:v1:`); never returned to a client. */
  env?: Record<string, string>;
}

/** Normalize a configured MCP server: exactly an http url or a stdio command, nothing invented. */
export function summarizeMcpServer(input: CreateMcpServerInput): McpServerTarget | null {
  const transport = input.transport ?? (input.url !== undefined ? 'http' : input.command !== undefined ? 'stdio' : undefined);
  if (transport === 'http') return input.url === undefined ? null : { transport, endpoint: input.url };
  if (transport === 'stdio') return input.command === undefined ? null : { transport, endpoint: input.command };
  return null;
}

export function createIntegrationsModule(scoped: Store, ownerId: string): IntegrationsModule {
  return {
    listPlugins(query: ListQuery): Promise<ListPage<Plugin>> {
      return scoped.list('plugins', query);
    },

    getPlugin(id: string): Promise<Plugin | null> {
      return scoped.get('plugins', id);
    },

    setPluginInstalled(id: string, installed: boolean): Promise<Plugin> {
      return scoped.patch('plugins', id, { installed });
    },

    async setToolPermission(
      pluginId: string,
      toolId: string,
      permission: ToolPermission,
    ): Promise<Plugin> {
      const plugin = await scoped.get('plugins', pluginId);
      if (!plugin) throw new NotFoundError('plugins', pluginId);
      if (!plugin.tools.some((tool) => tool.id === toolId)) {
        throw new NotFoundError('plugins.' + pluginId + '.tools', toolId);
      }
      const tools = plugin.tools.map((tool) => (tool.id === toolId ? { ...tool, permission } : tool));
      return scoped.patch('plugins', pluginId, { tools });
    },

    async createMcpConnection(input: CreateMcpServerInput): Promise<Connection> {
      const target = summarizeMcpServer(input);
      if (target === null) {
        throw new McpConfigError('MCP_CONFIG_INVALID', 'An MCP server requires either a url (http) or a command (stdio)');
      }
      const env = Object.entries(input.env ?? {});
      if (env.length > 0 && target.transport !== 'stdio') {
        throw new McpConfigError('MCP_ENV_STDIO_ONLY', 'Env values apply only to a stdio MCP server');
      }

      // Early refusal of non-http(s) and obviously private hosts; DNS-level checks run at connect time.
      if (target.transport === 'http' && mcpUrlRefused(target.endpoint)) {
        throw new McpConfigError('MCP_URL_BLOCKED', 'The MCP server URL must be a public http(s) address');
      }
      const connection: Connection = {
        id: 'con-' + randomUUID(),
        kind: 'mcp',
        name: input.name,
        status: 'disconnected',
        enabled: true,
        endpoint: target.endpoint,
      };
      const stored: StoredConnection = {
        ...connection,
        ownerId,
        transport: target.transport,
        ...(target.transport === 'stdio' && input.args !== undefined ? { args: input.args } : {}),
        ...(env.length > 0 ? { env: Object.fromEntries(env.map(([key, value]) => [key, encryptSecret(value)])) } : {}),
      };
      return connectionSchema.parse(await scoped.put('connections', stored));
    },
  };
}

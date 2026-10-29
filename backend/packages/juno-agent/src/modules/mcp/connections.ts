// Owner-scoped persistence for configured MCP connections. The stored status mirrors the real
// session state, a connection is only readable by its owner, an explicit enabled flag separates
// "never connected yet" from "disconnected by the user". A stdio server's env values are the only
// secrets kept here, and only encrypted (`enc:v1:`, see contracts/secrets.ts); they are decrypted
// when the config is rebuilt for a session and never returned to a client.
import { z } from 'zod';
import type { Store } from '../../contracts/index.js';
import { decryptSecret, encryptSecret } from '../../contracts/secrets.js';
import type { Connection } from '@agent-desktop/public-contracts';
import { readString, readStringArray, safeGet } from '../../execution/brain/social-read.js';
import type { McpConnectionState, McpConnectionStatus } from './client.js';
import type { McpServerConfig } from './config.js';

export interface StoredMcpConnection extends Connection {
  ownerId?: string;
  transport?: 'http' | 'stdio';
  args?: string[];
  env?: Record<string, string>;
  /** A custom server: the read / change marks the owner confirmed when adding it (a tool not named is a change). */
  toolMarks?: Record<string, 'read' | 'change'>;
}

const envSchema = z.record(z.string(), z.string());

export function readConnectionOwner(doc: object): string | undefined {
  return readString(doc, 'ownerId') ?? readString(doc, 'owner_id');
}

/** Missing `enabled` means enabled, so rows written before the flag stay usable. */
export function isConnectionEnabled(doc: object): boolean {
  return Reflect.get(doc, 'enabled') !== false;
}

/**
 * Rebuild the canonical server config from the stored endpoint plus the private transport fields.
 * Throws SecretsError when a stored env value cannot be decrypted (wrong key, tampered).
 */
export function storedConfig(doc: object): McpServerConfig | null {
  const endpoint = readString(doc, 'endpoint');
  if (endpoint === undefined) return null;
  if (readString(doc, 'transport') === 'stdio') {
    const args = readStringArray(doc, 'args') ?? [];
    const stored = envSchema.safeParse(Reflect.get(doc, 'env'));
    if (!stored.success) return { transport: 'stdio', command: endpoint, args };
    const env = Object.fromEntries(Object.entries(stored.data).map(([key, value]) => [key, decryptSecret(value)]));
    return { transport: 'stdio', command: endpoint, args, env };
  }
  // A connector whose headers carry the owner's own values (an API key) keeps them sealed, already resolved from `${user_config.KEY}`.
  const stored = envSchema.safeParse(Reflect.get(doc, 'headers'));
  return stored.success && Object.keys(stored.data).length > 0
    ? { transport: 'http', url: endpoint, headers: Object.fromEntries(Object.entries(stored.data).map(([name, value]) => [name, decryptSecret(value)])) }
    : { transport: 'http', url: endpoint };
}

export function connectionStatusFor(state: McpConnectionState): Connection['status'] {
  if (state === 'connected') return 'connected';
  if (state === 'error') return 'error';
  return 'disconnected';
}

export function createMcpConnectionStore(store: Store) {
  return {
    async save(
      ownerId: string,
      connectionId: string,
      name: string,
      config: McpServerConfig,
      status: McpConnectionStatus,
    ): Promise<Connection> {
      const endpoint = config.transport === 'http' ? config.url : config.command;
      const connection: StoredMcpConnection = {
        id: connectionId,
        kind: 'mcp',
        name,
        status: connectionStatusFor(status.state),
        endpoint,
        ownerId,
        enabled: true,
        transport: config.transport,
        ...(config.transport === 'stdio' ? { args: config.args } : {}),
        ...(config.transport === 'stdio' && config.env !== undefined
          ? { env: Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, encryptSecret(value)])) }
          : {}),
        ...(status.state === 'connected' ? { connectedAt: new Date().toISOString() } : {}),
      };
      return store.put('connections', connection);
    },

    async load(ownerId: string, connectionId: string): Promise<StoredMcpConnection | null> {
      const found = await safeGet(store, 'connections', connectionId);
      if (found.status !== 'ok') return null;
      if (readString(found.doc, 'ownerId') !== ownerId) return null;
      return found.doc;
    },
  };
}

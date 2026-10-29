/**
 * Vendor MCP servers this deployment calls with its own API key instead of a user sign-in (BACKEND 10.15):
 * Google Maps Grounding Lite takes `X-Goog-Api-Key`; public YouTube (YOUTUBE_API_KEY) is hosted by the gateway, which holds the key. The key is read from the environment on each request
 * and sent only to that exact origin, so it never reaches a client, a stored connection or another host.
 *
 * They need nothing from the owner, so every owner has them connected by default: when an owner's connections are
 * read (the agent's tools, the connector list) and none exists for the catalog id, a connection row is written.
 * Disconnecting keeps the row (disabled), so a server the owner turned off stays off.
 */
import { createHash } from 'node:crypto';
import type { Connection } from '@agent-desktop/public-contracts';
import type { StoredMcpConnection } from './connections.js';

export interface PlatformKeyServer {
  /** Connector catalog id of the entry (api modules/connector-catalog.ts). */
  catalogId: string;
  name: string;
  /** A vendor server called with the key in `header`; or (with `hostedPath`) empty, because this gateway hosts the server and calls the vendor API itself. */
  url: string;
  header?: string;
  /** Set for a server this gateway hosts (BACKEND 10.15): its path under BETTER_AUTH_URL. The key stays on the gateway. */
  hostedPath?: string;
  /** The environment variable holding the key. Absent: the server needs no key (a hosted public API), so it is offered wherever the gateway runs. */
  env?: string;
}

export const PLATFORM_KEY_SERVERS: readonly PlatformKeyServer[] = [
  { catalogId: 'google-maps', name: 'Google Maps', url: 'https://mapstools.googleapis.com/mcp', header: 'X-Goog-Api-Key', env: 'GOOGLE_MAPS_API_KEY' },
  { catalogId: 'youtube', name: 'YouTube', url: '', hostedPath: '/mcp/google/youtube', env: 'YOUTUBE_API_KEY' },
  { catalogId: 'sg-transport', name: 'Singapore transport', url: '', hostedPath: '/mcp/sg/sg-transport', env: 'LTA_ACCOUNT_KEY' },
];

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function keyFor(server: PlatformKeyServer, env: Record<string, string | undefined>): string | undefined {
  if (server.env === undefined) return '';
  const key = env[server.env];
  return key === undefined || key === '' ? undefined : key;
}

function entryFor(url: string, env: Record<string, string | undefined>): { header: string; key: string } | undefined {
  const origin = originOf(url);
  const server = PLATFORM_KEY_SERVERS.find((candidate) => candidate.header !== undefined && originOf(candidate.url) === origin);
  const key = server === undefined ? undefined : keyFor(server, env);
  return server?.header === undefined || key === undefined ? undefined : { header: server.header, key };
}

/**
 * A hosted platform-key server runs on this gateway's own quota, so the gateway only serves callers that hold the
 * internal service token (the one agentd and api already share). It is sent to this gateway's origin and that path only.
 */
function hostedAuthorization(url: string, env: Record<string, string | undefined>): string | undefined {
  const token = env['INTERNAL_AGENTD_TOKEN'];
  const own = env['BETTER_AUTH_URL'];
  if (token === undefined || token === '' || own === undefined || own === '') return undefined;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  const server = PLATFORM_KEY_SERVERS.find((candidate) => candidate.hostedPath !== undefined && candidate.hostedPath === target.pathname);
  return server === undefined || keyFor(server, env) === undefined || originOf(own) !== target.origin ? undefined : `Bearer ${token}`;
}

/** The key header for a request to `url`, or none (not a keyed server, or this deployment has no key). */
export function platformKeyHeaders(url: string, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const hosted = hostedAuthorization(url, env);
  if (hosted !== undefined) return { authorization: hosted };
  const found = entryFor(url, env);
  return found === undefined ? {} : { [found.header]: found.key };
}

/** A keyed server is offered only when the deployment has its key. */
export function platformKeyConfigured(catalogId: string, env: Record<string, string | undefined> = process.env): boolean {
  const server = PLATFORM_KEY_SERVERS.find((candidate) => candidate.catalogId === catalogId);
  return server !== undefined && keyFor(server, env) !== undefined;
}

/** Where a keyed server is called: the vendor's URL, or this gateway's public origin plus the hosted path. */
function endpointOf(server: PlatformKeyServer, env: Record<string, string | undefined>): string | undefined {
  if (server.hostedPath === undefined) return server.url;
  const own = env['BETTER_AUTH_URL'];
  return own === undefined || own === '' ? undefined : own.replace(/\/+$/, '') + server.hostedPath;
}

/**
 * The default connections an owner is missing: one per keyed server this deployment has a key for and the owner has
 * no connection to, enabled or not. The id comes from owner and catalog id, so concurrent first reads write one row.
 */
export function missingDefaultConnections(
  ownerId: string,
  existing: readonly Pick<Connection, 'catalogId'>[],
  env: Record<string, string | undefined> = process.env,
): StoredMcpConnection[] {
  const have = new Set(existing.map((connection) => connection.catalogId));
  return PLATFORM_KEY_SERVERS.filter((server) => !have.has(server.catalogId) && keyFor(server, env) !== undefined && endpointOf(server, env) !== undefined).map((server) => ({
    id: 'con-' + server.catalogId + '-' + createHash('sha256').update(ownerId).digest('hex').slice(0, 16),
    kind: 'mcp',
    name: server.name,
    status: 'connected',
    enabled: true,
    endpoint: endpointOf(server, env) ?? server.url,
    ownerId,
    transport: 'http',
    catalogId: server.catalogId,
    connectedAt: new Date().toISOString(),
  }));
}

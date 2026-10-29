/**
 * The connector catalog: code-defined, one entry per official remote MCP server. No third-party integration
 * platform sits behind it; each entry is a streamable-HTTP MCP endpoint the vendor documents, and the OAuth
 * grant and its tokens stay with us (BACKEND 10.15). An entry is added only when the vendor's own docs confirm
 * the endpoint and an OAuth login that works with our fixed redirect URI (dynamic registration, or a configured
 * client for the issuer). A Google service with a public API but no Google-run MCP server (YouTube, Tasks) is served by
 * this gateway (modules/google-mcp.ts): its `url` is a path here, made absolute with PUBLIC_URL by `resolveCatalog`,
 * and Google stays the authorization server. Not listed on purpose: Google Photos (since 2025-03-31 the Library
 * API only reads what the app itself uploaded; the Picker API needs the owner to pick photos each time), GitHub
 * (remote server OAuth not confirmed in its docs) and Slack (no dynamic registration; only directory-published
 * apps may connect), until a configured client exists. The entries themselves live in juno-agent (modules/mcp/catalog.ts)
 * and reach this process through agentd's plugin host (the `connectors-builtin` plugin and any other plugin's connectors);
 * this file adds the scopes of the hosted services, which only the gateway knows.
 */
import { HEVY_MCP_PATH, platformKeyConfigured, withoutCoveredComposio, type CatalogEntry } from '@agent-desktop/contracts/mcp';
import { McpAuthorizationError } from './mcp-authorization.js';
import { GOOGLE_MCP_PATH, SERVICES } from './google-mcp.js';
import { SG_MCP_PATH } from './sg-mcp.js';

export type { CatalogEntry };

/** A hosted OAuth entry asks for the scopes its tools need (modules/google-mcp.ts). */
export function withGatewayScopes(entries: readonly CatalogEntry[]): CatalogEntry[] {
  return entries.map((entry) => {
    const service = entry.url.startsWith(GOOGLE_MCP_PATH) ? entry.url.slice(GOOGLE_MCP_PATH.length) : undefined;
    return service !== undefined && entry.configuredClientIssuer !== undefined ? { ...entry, scopes: SERVICES[service]?.scopes ?? [] } : entry;
  });
}

/** How long the gateway trusts the catalog it read from agentd; an admin edit made through this gateway drops it at once (`invalidate`), one made elsewhere shows within this. */
const CATALOG_TTL_MS = 30_000;

/** What the gateway reads of the catalog: the apps offered for adding, and also the hidden ones (an owner who added one can still remove it). */
export interface AgentdCatalog {
  /** The apps offered for adding. */
  (): Promise<readonly CatalogEntry[]>;
  /** Offered and hidden apps: what an existing installation is looked up in. */
  held(): Promise<readonly CatalogEntry[]>;
  /** Forget what was read, so the next call reads agentd again (after an admin write through this gateway). */
  invalidate(): void;
}

/**
 * The connector catalog as the gateway sees it: the one agentd serves from its app catalog table (agentd
 * `GET /internal/connector-catalog`), read on demand and cached briefly. The gateway never holds a catalog of its
 * own, so an app retired in agentd is gone here too. When agentd cannot be reached the last good catalog is
 * served; with none yet, the call fails (503) rather than showing an empty store.
 */
export function createAgentdCatalog(deps: { agentdUrl: string; internalToken: string; fetchFn: typeof fetch; ttlMs?: number; now?: () => number }): AgentdCatalog {
  const now = deps.now ?? Date.now;
  interface Read { items: readonly CatalogEntry[]; held: readonly CatalogEntry[] }
  let cached: (Read & { at: number }) | undefined;
  let loading: Promise<Read> | undefined;
  let generation = 0;
  const load = async (): Promise<Read> => {
    const response = await deps.fetchFn(deps.agentdUrl.replace(/\/$/, '') + '/internal/connector-catalog', {
      headers: { authorization: 'Bearer ' + deps.internalToken },
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('agentd answered ' + String(response.status));
    const body: unknown = await response.json();
    const items = typeof body === 'object' && body !== null ? Reflect.get(body, 'items') : undefined;
    if (!Array.isArray(items)) throw new Error('agentd sent no connector list');
    const held: unknown = Reflect.get(body as object, 'held');
    const offered = withGatewayScopes(items as CatalogEntry[]);
    const heldEntries = Array.isArray(held) ? withGatewayScopes(held as CatalogEntry[]) : offered;
    validateCatalog(heldEntries);
    return { items: offered, held: heldEntries };
  };
  const read = async (): Promise<Read> => {
    if (cached !== undefined && now() - cached.at < (deps.ttlMs ?? CATALOG_TTL_MS)) return cached;
    const mine = generation;
    loading ??= load().then((value) => { if (mine === generation) cached = { ...value, at: now() }; return value; }).finally(() => { loading = undefined; });
    try {
      return await loading;
    } catch (error) {
      if (cached !== undefined) return cached;
      throw new McpAuthorizationError(503, 'CONNECTOR_CATALOG_UNAVAILABLE', 'The connector catalog is unavailable: ' + (error instanceof Error ? error.message : String(error)));
    }
  };
  return Object.assign(async () => (await read()).items, {
    held: async () => (await read()).held,
    invalidate: () => { generation += 1; cached = undefined; loading = undefined; },
  });
}

/**
 * Entries hosted by this gateway get its public origin; without one (no PUBLIC_URL) they are left out, and so
 * is a keyed entry when the deployment has no key for it.
 */
export function resolveCatalog(catalog: readonly CatalogEntry[], publicUrl: string | undefined, env: Record<string, string | undefined>): CatalogEntry[] {
  return withoutCoveredComposio(catalog, env).flatMap((entry) => {
    if (entry.platformKey === true && !platformKeyConfigured(entry.id, env)) return [];
    if (!entry.url.startsWith('/')) return [entry];
    if (publicUrl === undefined) return [];
    return [{ ...entry, url: publicUrl.replace(/\/+$/, '') + entry.url }];
  });
}

/** https, or loopback http for the e2e fixture (the MCP guard refuses loopback unless the dev escape hatch is set). */
function isSecure(raw: string): boolean {
  const url = new URL(raw);
  return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1');
}

/** Catalog invariants; throws a readable message on the first violation. Run at startup and in tests. */
export function validateCatalog(catalog: readonly CatalogEntry[]): void {
  const seen = new Set<string>();
  for (const entry of catalog) {
    if (!/^[a-z0-9-]+$/.test(entry.id)) throw new Error('connector id is not a slug: ' + entry.id);
    if (seen.has(entry.id)) throw new Error('duplicate connector id: ' + entry.id);
    seen.add(entry.id);
    // A hosted entry (a path) is served from this gateway's own origin, whatever PUBLIC_URL the deployment chose.
    // A Composio entry has no address of its own: the per-user MCP address comes from a Composio session at install.
    if (entry.source === 'composio') {
      if (entry.toolkit === undefined) throw new Error('connector ' + entry.id + ' from Composio needs a toolkit');
      continue;
    }
    const hosted = entry.url.startsWith(GOOGLE_MCP_PATH) || entry.url.startsWith(SG_MCP_PATH) || entry.url === HEVY_MCP_PATH;
    if (!hosted && !isSecure(entry.url)) throw new Error('connector ' + entry.id + ' must use an https MCP url');
    if (entry.name === '' || entry.description === '') throw new Error('connector ' + entry.id + ' needs a name and description');
    if (entry.configuredClientIssuer !== undefined && (entry.scopes === undefined || entry.scopes.length === 0)) {
      throw new Error('connector ' + entry.id + ' needs a configured client and so documented scopes');
    }
    if (entry.revocationEndpoint !== undefined && !isSecure(entry.revocationEndpoint)) {
      throw new Error('connector ' + entry.id + ' revocation endpoint must be https');
    }
  }
}

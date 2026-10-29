/**
 * Adding and removing the work and custom apps (BACKEND 10.18). An installation of a work app is an ordinary MCP `connections` row
 * (catalog id, documented scopes); a custom app is the same row for a server the owner named. The gateway does this part because it
 * owns the OAuth callback: install reuses the MCP authorization (discovery, PKCE, configured client or dynamic registration) and the
 * callback completes it as for any MCP server. What the Apps page lists and which agents use an app is agentd's.
 */
import { randomUUID } from 'node:crypto';
import type { Store } from '@agent-desktop/contracts';
import { connectionSchema, type Connection, type CreateMcpServerInput, type CustomAppConfirm, type InstallAppResponse, type ProbeCustomAppResponse } from '@agent-desktop/public-contracts';
import { encryptSecret } from '@agent-desktop/contracts/secrets';
import { appIdOfConnection, composioAuthConfig, composioOffered, connectionInstallation, entryClientAvailable, connectionStanding, mcpUrlRefused, McpOAuthError, openOAuth, probeMcpEndpoint, type McpManager } from '@agent-desktop/contracts/mcp';
import { callbackBase, chosenReturnUrl, clientMetadataUrl, McpAuthorizationError, startMcpAuthorization, type McpAuthorizationDeps } from './mcp-authorization.js';
import { COMPOSIO_CALLBACK_PATH, newComposioPending, type ComposioClient } from './composio.js';
import { createIntegrationsModule } from './integrations.js';
import type { CatalogEntry } from './connector-catalog.js';

export interface ConnectorsDeps {
  /** Composio, when COMPOSIO_API_KEY is set; without it no Composio app is offered and none can be added (no fallback). */
  composio?: ComposioClient;
  authorization: McpAuthorizationDeps;
  /** The connectors this deployment offers for adding, read per call (agentd's app catalog table, cached; see connector-catalog.ts). */
  catalog: () => Promise<readonly CatalogEntry[]>;
  /** Those and the hidden ones: what an installation that already exists is looked up in, to revoke its grant on removal. */
  held: () => Promise<readonly CatalogEntry[]>;
  manager: McpManager;
}

function scopedStore(store: Store, ownerId: string): Store {
  const scoped = store.forOwner?.(ownerId);
  if (scoped === undefined) throw new Error('store is missing forOwner; refusing an unscoped connector access');
  return scoped;
}

async function listOwned(scoped: Store): Promise<Connection[]> {
  const found: Connection[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const listed = await scoped.list('connections', cursor === undefined ? { limit: 200 } : { limit: 200, cursor });
    found.push(...listed.items);
    cursor = listed.nextCursor;
    if (cursor === undefined) break;
  }
  return found;
}

function isAvailable(deps: ConnectorsDeps, entry: CatalogEntry): boolean {
  return entryClientAvailable(entry, deps.authorization.env);
}

/** What `install` answers: the account when it is added already, and the page to sign in at when it is not. */
function installed(connection: Connection, appId: string, appName: string, authorizationUrl: string | null): InstallAppResponse {
  return { appId, installation: connectionInstallation(connection, appId, appName) ?? null, pending: null, openUrl: authorizationUrl };
}

const MAX_VALUE_LENGTH = 512;
type UserValues = Record<string, string | number | boolean>;

/** What adding an app stores from the owner's values: the resolved URL, the resolved headers, and every value, ready to be sealed. */
export interface ResolvedUserConfig {
  endpoint: string;
  headers: Record<string, string>;
  values: Record<string, string>;
}

const TEMPLATE = /\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Check the owner's values against the fields the app declares (Claude plugins' `userConfig`): unknown keys, missing required ones, wrong
 * types and values outside `options` are refused with a 400 that names the field; defaults fill what was left out. Then the URL and headers
 * are resolved from `${user_config.KEY}`. A sensitive value reaches only a header (the package check guarantees it is not in the URL).
 */
export function resolveUserConfig(entry: CatalogEntry, input: UserValues | undefined): ResolvedUserConfig {
  const declared = entry.userConfig ?? {};
  const given = input ?? {};
  const unknown = Object.keys(given).find((key) => declared[key] === undefined);
  if (unknown !== undefined) throw new McpAuthorizationError(400, 'CONNECTOR_CONFIG_UNKNOWN', entry.name + ' does not take a value called ' + unknown);
  const values: Record<string, string> = {};
  for (const [key, field] of Object.entries(declared)) {
    const supplied = given[key] ?? field.default;
    const value = typeof supplied === 'string' ? supplied.trim() : supplied;
    if (value === undefined || value === '') {
      if (field.required === true) throw new McpAuthorizationError(400, 'CONNECTOR_CONFIG_REQUIRED', 'Provide ' + field.title + ' to connect ' + entry.name);
      continue;
    }
    if (typeof value !== field.type) throw new McpAuthorizationError(400, 'CONNECTOR_CONFIG_INVALID', field.title + ' must be a ' + field.type);
    const text = String(value);
    if (text.length > MAX_VALUE_LENGTH) throw new McpAuthorizationError(400, 'CONNECTOR_CONFIG_INVALID', field.title + ' is too long');
    if (field.options !== undefined && !field.options.includes(text)) throw new McpAuthorizationError(400, 'CONNECTOR_CONFIG_INVALID', field.title + ' must be one of: ' + field.options.join(', '));
    values[key] = text;
  }
  const fill = (template: string, encode: (value: string) => string): string => template.replace(TEMPLATE, (_all, key: string) => encode(values[key] ?? ''));
  return {
    endpoint: fill(entry.url, encodeURIComponent),
    headers: Object.fromEntries(Object.entries(entry.headers ?? {}).map(([name, template]) => [name, fill(template, (value) => value)]).filter(([, value]) => value !== '')),
    values,
  };
}

/** The fields a connection row keeps for an app that took values: the resolved URL, and the headers and values sealed. */
function userConfigFields(resolved: ResolvedUserConfig, entry: CatalogEntry): Record<string, unknown> {
  const seal = (record: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, encryptSecret(value)]));
  return {
    endpoint: resolved.endpoint,
    headers: Object.keys(resolved.headers).length === 0 ? null : seal(resolved.headers),
    userConfig: Object.keys(resolved.values).length === 0 ? null : seal(resolved.values),
    ...(entry.version === undefined ? {} : { catalogVersion: entry.version }),
  };
}

/**
 * An app added with the owner's values and no sign-in (an API key in a header): after the catalog entry's read-only probe call succeeds with
 * them, they are sealed on the owner's connection row and the row is connected. Sending values again replaces them and drops the sessions
 * that used the old ones. A probe that fails stores nothing (a new row is never made, a working account is left as it was) and answers 400
 * `CONNECTOR_PROBE_FAILED` with the reason; an OAuth app has no probe, the sign-in is the proof (BACKEND 10.18.1).
 */
async function installDirect(deps: ConnectorsDeps, entry: CatalogEntry, ownerId: string, existing: Connection | undefined, input: UserValues | undefined): Promise<InstallAppResponse> {
  const resolved = resolveUserConfig(entry, input);
  const scoped = scopedStore(deps.authorization.store, ownerId);
  if (entry.probe !== undefined) {
    const probed = await deps.manager.probe({ url: resolved.endpoint, headers: resolved.headers, tool: entry.probe.tool, ...(entry.probe.args === undefined ? {} : { args: entry.probe.args }) });
    if (!probed.ok) throw new McpAuthorizationError(400, 'CONNECTOR_PROBE_FAILED', 'Could not connect ' + entry.name + ': ' + probed.reason + '. Check the value and try again.');
  }
  if (existing !== undefined) await deps.manager.disconnect({ ownerId, store: scoped, connectionId: existing.id });
  const fields = { status: 'connected', enabled: true, connectedAt: new Date().toISOString(), auth: null, ...userConfigFields(resolved, entry) };
  const row = existing === undefined
    ? await scoped.put('connections', { id: 'con-' + randomUUID(), kind: 'mcp', name: entry.name, ownerId, transport: 'http', catalogId: entry.id, ...fields } as never)
    : await scoped.patch('connections', existing.id, fields as never);
  return installed(connectionSchema.parse(row), entry.id, entry.name, null);
}

export interface InstallWorkInput { returnUrl?: string; userConfig?: UserValues; connectionId?: string }

/**
 * Adds a Composio app (BACKEND 10.18.3): a session for this owner and the row's toolkit gives the per-user MCP address and its header, kept sealed
 * on an ordinary connection row. When the owner has no connected account for the toolkit yet, Composio's login page is the `openUrl`; it returns to
 * `/oauth/composio/callback`, which asks Composio whether the login happened. The login stays with Composio ("Login held by Composio").
 */
async function installComposio(deps: ConnectorsDeps, entry: CatalogEntry, ownerId: string, existing: Connection | undefined, input: InstallWorkInput, requestOrigin: string | undefined): Promise<InstallAppResponse> {
  const env = deps.authorization.env;
  if (deps.composio === undefined || entry.toolkit === undefined || !composioOffered(entry, env)) {
    throw new McpAuthorizationError(400, 'COMPOSIO_NOT_CONFIGURED', entry.name + ' needs Composio configured on this deployment');
  }
  const authConfigId = composioAuthConfig(entry.toolkit, env);
  const session = await deps.composio.session({ userId: ownerId, toolkit: entry.toolkit, ...(authConfigId === undefined ? {} : { authConfigId }) });
  const active = await deps.composio.connected(session.sessionId, entry.toolkit);
  const base = callbackBase(deps.authorization, requestOrigin);
  if (!active && base === undefined) throw new McpAuthorizationError(503, 'MCP_OAUTH_NOT_CONFIGURED', 'The login (PUBLIC_URL) is not configured on this deployment');
  const scoped = scopedStore(deps.authorization.store, ownerId);
  const id = existing?.id ?? 'con-' + randomUUID();
  const { state, pending } = newComposioPending(id, chosenReturnUrl(deps.authorization, input.returnUrl));
  const fields = {
    status: active ? 'connected' : 'disconnected',
    enabled: true,
    endpoint: session.mcpUrl,
    headers: Object.fromEntries(Object.entries(session.headers).map(([name, value]) => [name, encryptSecret(value)])),
    composioSessionId: session.sessionId,
    composioPending: active ? null : pending,
    auth: null,
    ...(active ? { connectedAt: new Date().toISOString() } : {}),
    ...(entry.version === undefined ? {} : { catalogVersion: entry.version }),
  };
  const row = existing === undefined
    ? await scoped.put('connections', { id, kind: 'mcp', name: entry.name, ownerId, transport: 'http', catalogId: entry.id, ...fields } as never)
    : await scoped.patch('connections', id, fields as never);
  if (active || base === undefined) return installed(connectionSchema.parse(row), entry.id, entry.name, null);
  const redirect = await deps.composio.link(session.sessionId, entry.toolkit, base.replace(/\/+$/, '') + COMPOSIO_CALLBACK_PATH + '?state=' + encodeURIComponent(state));
  return installed(connectionSchema.parse(row), entry.id, entry.name, redirect);
}

/**
 * Adds a catalog app, or signs in to it again. An account that is not signed in (expired, half made, removed) is reused; when every
 * account is signed in, installing adds another one. `connectionId` names the account to sign in to again (or whose key to replace).
 */
export async function installWorkApp(deps: ConnectorsDeps, ownerId: string, appId: string, input: InstallWorkInput, requestOrigin?: string): Promise<InstallAppResponse> {
  const entry = (await deps.catalog()).find((candidate) => candidate.id === appId);
  if (entry === undefined) throw new McpAuthorizationError(404, 'APP_NOT_FOUND', 'app ' + appId + ' is not available on this deployment');
  // A refused return URL must not leave a half-made account behind.
  chosenReturnUrl(deps.authorization, input.returnUrl);
  const scoped = scopedStore(deps.authorization.store, ownerId);
  const mine = (await listOwned(scoped)).filter((connection) => connection.catalogId === entry.id);
  const named = input.connectionId === undefined ? undefined : mine.find((connection) => connection.id === input.connectionId);
  if (input.connectionId !== undefined && named === undefined) throw new McpAuthorizationError(404, 'INSTALLATION_NOT_FOUND', 'No such account of ' + entry.name);
  if (entry.source === 'composio') return installComposio(deps, entry, ownerId, named ?? mine[0], input, requestOrigin);
  // The package can declare what this install flow does not do yet (more than one server, public-and-signed-in tools): refused with a reason, not half done.
  if (entry.installBlock !== undefined) throw new McpAuthorizationError(400, 'APP_NOT_SUPPORTED_YET', entry.installBlock);
  // A key or other values and no sign-in: sealed on the row, connected at once. A platform-key server is on already and goes the sign-in way (an open probe connects it).
  if (entry.auth === 'api_key' || (entry.auth === 'none' && entry.platformKey !== true)) return installDirect(deps, entry, ownerId, named ?? mine[0], input.userConfig);
  if (!isAvailable(deps, entry)) {
    throw new McpAuthorizationError(400, 'MCP_OAUTH_NO_CLIENT', entry.name + ' needs an OAuth client configured on this deployment');
  }
  // The values the app declares (a workspace name in its URL) are resolved before the sign-in starts, which probes the resolved address.
  const resolved = resolveUserConfig(entry, input.userConfig);
  const keep = {
    enabled: true,
    ...userConfigFields(resolved, entry),
    ...(entry.scopes === undefined ? {} : { scopes: entry.scopes }),
    oauthClient: entry.oauthClient ?? null,
    oauthClientIdName: entry.clientIdName ?? null,
    oauthClientSecretName: entry.clientSecretName ?? null,
  };
  const target = named ?? mine.find((connection) => connectionStanding(connection) !== 'connected');
  const row = target === undefined
    ? await scoped.put('connections', {
      id: 'con-' + randomUUID(),
      kind: 'mcp',
      name: entry.name,
      status: 'disconnected',
      ownerId,
      transport: 'http',
      catalogId: entry.id,
      ...keep,
    } as never)
    : await scoped.patch('connections', target.id, keep as never);
  const started = await startMcpAuthorization(deps.authorization, ownerId, row.id, requestOrigin, input.returnUrl);
  return installed(started.connection, entry.id, entry.name, started.authorizationUrl);
}

/**
 * What an MCP server at `url` asks for, found without a login (BACKEND 10.18.3): how it lets people in, and, when it answers without one, its tools
 * with a suggested read / change mark each. The first step of adding a custom server; the owner confirms it with `installCustomApp`. Nothing is stored.
 */
export async function probeCustomApp(deps: ConnectorsDeps, url: string): Promise<ProbeCustomAppResponse> {
  if (mcpUrlRefused(url)) throw new McpAuthorizationError(400, 'MCP_URL_BLOCKED', 'The MCP server URL must be a public http(s) address');
  let found;
  try {
    found = await probeMcpEndpoint(url, { fetchImpl: deps.authorization.fetchImpl, env: deps.authorization.env, cimd: clientMetadataUrl(deps.authorization) !== undefined });
  } catch (error) {
    if (error instanceof McpOAuthError) throw new McpAuthorizationError(error.code === 'MCP_URL_BLOCKED' ? 400 : 502, error.code, error.message);
    throw error;
  }
  const oauth = found.oauth;
  const problem = found.auth === 'api_key'
    ? 'This server wants an API key, which a custom server cannot take yet.'
    : oauth !== undefined && !oauth.usable
      ? 'This server needs an OAuth client registered with ' + oauth.issuer + ' first, and this deployment has none.'
      : undefined;
  return {
    url: found.url,
    auth: found.auth,
    usable: problem === undefined,
    ...(problem === undefined ? {} : { problem }),
    ...(oauth === undefined ? {} : { oauth: { issuer: oauth.issuer, scopes: oauth.scopes, client: oauth.client } }),
    ...(found.tools === undefined ? {} : { tools: found.tools }),
    ...(found.toolsTruncated === true ? { toolsTruncated: true } : {}),
  };
}

/** A server added by URL must be probed and confirmed: it is probed again here and must still say what the owner confirmed; their marks are kept on the connection. */
async function confirmedMarks(deps: ConnectorsDeps, input: CreateMcpServerInput & { confirm?: CustomAppConfirm }): Promise<Record<string, 'read' | 'change'> | undefined> {
  const isRemote = (input.transport ?? (input.url !== undefined ? 'http' : 'stdio')) === 'http';
  // A command needs no probe; env values on a URL are refused by the connection itself (MCP_ENV_STDIO_ONLY), before anything is looked at.
  if (!isRemote || input.env !== undefined) return undefined;
  if (input.confirm === undefined || input.url === undefined) throw new McpAuthorizationError(400, 'CUSTOM_PROBE_REQUIRED', 'Look at the server first (POST /v1/apps/custom/probe), then add it with the confirmation');
  const now = await probeCustomApp(deps, input.url);
  if (!now.usable) throw new McpAuthorizationError(400, 'CUSTOM_NOT_USABLE', now.problem ?? 'This server cannot be added here');
  if (now.auth !== input.confirm.auth) throw new McpAuthorizationError(409, 'CUSTOM_PROBE_CHANGED', 'The server now asks for a different login than the one you confirmed; look at it again');
  return input.confirm.tools;
}

/** Adds a custom MCP server by URL (probed and confirmed) or command, or signs in to one the owner added before (`connectionId`). */
export async function installCustomApp(deps: ConnectorsDeps, ownerId: string, input: (CreateMcpServerInput & { confirm?: CustomAppConfirm }) | { connectionId: string; returnUrl?: string }, requestOrigin?: string): Promise<InstallAppResponse> {
  const scoped = scopedStore(deps.authorization.store, ownerId);
  let connection: Connection;
  let returnUrl: string | undefined;
  if ('connectionId' in input) {
    chosenReturnUrl(deps.authorization, input.returnUrl);
    const existing = await scoped.get('connections', input.connectionId);
    if (existing === null || existing.kind !== 'mcp' || existing.catalogId !== undefined) throw new McpAuthorizationError(404, 'INSTALLATION_NOT_FOUND', 'No such custom app');
    connection = connectionSchema.parse(existing);
    returnUrl = input.returnUrl;
  } else {
    const marks = await confirmedMarks(deps, input);
    const { confirm: _confirmed, ...server } = input;
    connection = await createIntegrationsModule(scoped, ownerId).createMcpConnection(server);
    if (marks !== undefined) await scoped.patch('connections', connection.id, { toolMarks: marks } as never);
  }
  // A remote server signs in; a command is started in the agent's computer when it is first used.
  const stored = await scoped.get('connections', connection.id);
  if (stored !== null && Reflect.get(stored, 'transport') !== 'http') return installed(stored, connection.id, connection.name, null);
  const started = await startMcpAuthorization(deps.authorization, ownerId, connection.id, requestOrigin, returnUrl);
  return installed(started.connection, connection.id, connection.name, started.authorizationUrl);
}

/** Best-effort RFC 7009 revocation of the stored grant; a failure never blocks the removal. */
async function revokeGrant(deps: ConnectorsDeps, entry: CatalogEntry, stored: unknown): Promise<void> {
  if (entry.revocationEndpoint === undefined) return;
  try {
    const record = openOAuth(stored);
    const token = record?.refreshToken ?? record?.accessToken;
    if (token === undefined) return;
    const response = await deps.authorization.fetchImpl(entry.revocationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    await response.body?.cancel().catch(() => undefined);
  } catch {
    // Removal proceeds: the local tokens are dropped either way.
  }
}

/** Removes one account (or custom server): the grant is revoked where the provider supports it, the tokens and sessions go, the row stays. */
export async function removeAppInstallation(deps: ConnectorsDeps, ownerId: string, appId: string, installationId: string): Promise<void> {
  const scoped = scopedStore(deps.authorization.store, ownerId);
  const connection = await scoped.get('connections', installationId);
  if (connection === null || connection.kind !== 'mcp' || appIdOfConnection(connection) !== appId) {
    throw new McpAuthorizationError(404, 'INSTALLATION_NOT_FOUND', 'No such installation');
  }
  // A hidden app can still be removed with its grant revoked; a retired one has no provider entry left to revoke with, and is removed all the same.
  const entry = connection.catalogId === undefined ? undefined : (await deps.held()).find((candidate) => candidate.id === connection.catalogId);
  if (entry !== undefined) await revokeGrant(deps, entry, Reflect.get(connection, 'auth'));
  await deps.manager.disconnect({ ownerId, store: scoped, connectionId: installationId });
}

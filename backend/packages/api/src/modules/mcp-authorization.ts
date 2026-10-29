/**
 * Connect flow for a remote streamable-HTTP MCP server. `start` probes the server, runs discovery and
 * client selection (a stored client, an environment-configured one, or dynamic registration) and records
 * a pending PKCE authorization on the connection; `complete` handles the browser callback: the state must
 * name a connection with a live, unused pending nonce, the code is exchanged with the fixed redirect URI,
 * the tokens are stored sealed, and the server is verified before the status flips to connected.
 *
 * Owner: `start` is scoped to the caller. `complete` has no session (it is a browser redirect), so the
 * owner comes from the connection row the state names, never from the request.
 */
import type { Store } from '@agent-desktop/contracts';
import { connectionSchema, type Connection } from '@agent-desktop/public-contracts';
import {
  buildAuthorizationUrl,
  chooseClient,
  configuredClientFor,
  mergeScopes,
  type ClientSecretNames,
  createPkce,
  createState,
  discoverAuthorizationServer,
  exchangeCode,
  HttpMcpTransport,
  loopbackRedirectBase,
  McpClient,
  McpOAuthError,
  nonceMatches,
  openOAuth,
  parseState,
  probeMcpServer,
  registerClient,
  sealOAuth,
  type OAuthRecord,
} from '@agent-desktop/contracts/mcp';

export const CALLBACK_PATH = '/oauth/mcp/callback';
const PENDING_TTL_MS = 10 * 60_000;
/** A server that keeps asking for more scope cannot loop the owner through sign-ins: after this many step-ups it is just an error. */
const STEP_UP_LIMIT = 3;

/** The names of the deployment secrets an app's package gives for its provided OAuth client, kept on the connection when it was added. */
function clientNamesOf(doc: object): ClientSecretNames | undefined {
  const idName = Reflect.get(doc, 'oauthClientIdName');
  const secretName = Reflect.get(doc, 'oauthClientSecretName');
  return typeof idName === 'string' ? { idName, ...(typeof secretName === 'string' ? { secretName } : {}) } : undefined;
}

function clientModeOf(doc: object): 'provided' | 'cimd' | 'dcr' | undefined {
  const mode = Reflect.get(doc, 'oauthClient');
  return mode === 'provided' || mode === 'cimd' || mode === 'dcr' ? mode : undefined;
}

export interface McpAuthorizationDeps {
  store: Store;
  /**
   * The API's public origin. The redirect URI is `<origin> + CALLBACK_PATH` where origin is the one the connect
   * request came in on when it is publicUrl or listed in PUBLIC_ORIGINS (the phone reaches the API on another
   * origin than the Mac), else publicUrl; it is never an origin outside that list.
   */
  publicUrl?: string;
  /** Where the browser lands after the callback: `returnUrl?connection=<id>&status=connected|error`. */
  returnUrl: string;
  /**
   * Other return URLs a connect request may choose (MCP_OAUTH_APP_RETURN_URLS, e.g. the iPhone app's `juno://connectors`,
   * which ASWebAuthenticationSession catches). Matched exactly; anything else is refused.
   */
  appReturnUrls?: string[];
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  /** Called with the owner after the OAuth callback connected a connection (the routines waiting for it start). */
  connectionsChanged?: (ownerId: string) => void;
}

/** A request-level failure the route maps to an HTTP status and a stable code. */
export class McpAuthorizationError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'McpAuthorizationError';
  }
}

/** Nonce hashes already redeemed in this process, with their expiry: a replayed callback is refused. */
const redeemed = new Map<string, number>();

function pruneRedeemed(now: number): void {
  for (const [hash, expiresAt] of redeemed) if (expiresAt <= now) redeemed.delete(hash);
}

function ownerScoped(store: Store, ownerId: string): Store {
  const scoped = store.forOwner?.(ownerId);
  if (scoped === undefined) throw new Error('store is missing forOwner; refusing an unscoped MCP authorization');
  return scoped;
}

function unavailable(what: string): McpAuthorizationError {
  return new McpAuthorizationError(503, 'MCP_OAUTH_NOT_CONFIGURED', what + ' is not configured on this deployment');
}

function failure(error: unknown): unknown {
  if (error instanceof McpOAuthError) {
    // A provider without a client, or a URL the private-network guard refuses, is the owner's to fix (400);
    // anything else is upstream (502).
    const status = error.code === 'MCP_OAUTH_NO_CLIENT' || error.code === 'MCP_OAUTH_CIMD_UNSUPPORTED' || error.code === 'MCP_URL_BLOCKED' ? 400 : 502;
    return new McpAuthorizationError(status, error.code, error.message);
  }
  return error;
}

export function callbackUrl(publicUrl: string): string {
  return publicUrl.replace(/\/+$/, '') + CALLBACK_PATH;
}

/** Where this gateway serves its client metadata document (CIMD); the client id of a sign-in made that way is this URL. */
export const CLIENT_METADATA_PATH = '/oauth/mcp/client-metadata.json';

/**
 * The CIMD client id: MCP_CLIENT_METADATA_URL when the operator hosts the document elsewhere, else this gateway's own path when its public
 * address is https (a provider fetches the document, so a local http address cannot be a client id). Undefined: no CIMD on this deployment.
 */
export function clientMetadataUrl(deps: Pick<McpAuthorizationDeps, 'publicUrl' | 'env'>): string | undefined {
  const configured = deps.env.MCP_CLIENT_METADATA_URL;
  if (configured !== undefined && configured !== '') return /^https:\/\//.test(configured) ? configured : undefined;
  return deps.publicUrl !== undefined && deps.publicUrl.startsWith('https://') ? deps.publicUrl.replace(/\/+$/, '') + CLIENT_METADATA_PATH : undefined;
}

/** The redirect URIs the client metadata document lists: the callback of each origin a connect request may come in on. */
export function clientRedirectUris(deps: Pick<McpAuthorizationDeps, 'publicUrl' | 'env'>): string[] {
  const origins = [deps.publicUrl, ...(deps.env.PUBLIC_ORIGINS ?? '').split(',')].flatMap((raw) => (raw === undefined ? [] : originOf(raw) ?? []));
  return [...new Set(origins.map((origin) => callbackUrl(origin)))];
}

function originOf(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** The callback base for a connect request: its origin when allow-listed (publicUrl and PUBLIC_ORIGINS), else publicUrl. */
export function callbackBase(deps: Pick<McpAuthorizationDeps, 'publicUrl' | 'env'>, requestOrigin: string | undefined): string | undefined {
  if (deps.publicUrl === undefined) return undefined;
  const allowed = [deps.publicUrl, ...(deps.env.PUBLIC_ORIGINS ?? '').split(',')].map(originOf);
  const origin = requestOrigin === undefined ? undefined : originOf(requestOrigin);
  return origin !== undefined && allowed.includes(origin) ? origin : deps.publicUrl;
}

/** A requested return URL must be MCP_OAUTH_RETURN_URL or one of the app return URLs; none means the default. */
export function chosenReturnUrl(deps: Pick<McpAuthorizationDeps, 'returnUrl' | 'appReturnUrls'>, requested: string | undefined): string | undefined {
  if (requested === undefined || requested === deps.returnUrl) return undefined;
  if (deps.appReturnUrls?.includes(requested) === true) return requested;
  throw new McpAuthorizationError(400, 'MCP_OAUTH_RETURN_URL_REFUSED', 'This return URL is not allowed');
}

/** Starts (or restarts) the authorization for one owned HTTP connection. `authorizationUrl` null means no login was needed. */
export async function startMcpAuthorization(
  deps: McpAuthorizationDeps,
  ownerId: string,
  connectionId: string,
  requestOrigin?: string,
  requestedReturnUrl?: string,
): Promise<{ connection: Connection; authorizationUrl: string | null }> {
  const returnUrl = chosenReturnUrl(deps, requestedReturnUrl);
  const scoped = ownerScoped(deps.store, ownerId);
  const doc = await scoped.get('connections', connectionId);
  if (doc === null || doc.kind !== 'mcp') throw new McpAuthorizationError(404, 'NOT_FOUND', 'connections ' + connectionId + ' not found');
  const endpoint = doc.endpoint;
  if (Reflect.get(doc, 'transport') !== 'http' || endpoint === undefined) {
    throw new McpAuthorizationError(400, 'MCP_AUTH_HTTP_ONLY', 'Only a remote http MCP server can be authorized');
  }

  let probe;
  try {
    probe = await probeMcpServer(endpoint, deps.fetchImpl);
  } catch (error) {
    throw failure(error);
  }
  // Catalog connectors carry the scopes the vendor documents; they go into the authorization request.
  const scopes: unknown = Reflect.get(doc, 'scopes');
  const scopeParam: Record<string, string> = Array.isArray(scopes) && scopes.length > 0 && scopes.every((scope) => typeof scope === 'string') ? { scope: scopes.join(' ') } : {};
  // An entry with scopes always signs in: Google's MCP servers answer an unauthenticated initialize and only
  // refuse the tool calls, so an open probe there does not mean no login is needed.
  if (probe.open && Object.keys(scopeParam).length === 0) {
    const connected = await scoped.patch('connections', connectionId, {
      status: 'connected',
      enabled: true,
      connectedAt: new Date().toISOString(),
      auth: null,
    } as never);
    return { connection: connectionSchema.parse(connected), authorizationUrl: null };
  }

  const base = callbackBase(deps, requestOrigin);
  if (base === undefined) throw unavailable('MCP authorization (PUBLIC_URL)');
  let server;
  let client;
  let redirectUri: string;
  const names = clientNamesOf(doc);
  const mode = clientModeOf(doc);
  try {
    server = await discoverAuthorizationServer(endpoint, probe.resourceMetadataUrl, deps.fetchImpl);
    // The token exchange uses the same redirect URI (kept in the pending authorization). Microsoft matches a loopback
    // redirect by host and path only, so its desktop client is sent to `localhost`; every other base is used as given.
    redirectUri = callbackUrl(loopbackRedirectBase(base, server.issuer));
    const provided = configuredClientFor(server.issuer, deps.env, names);
    const previous = openOAuth(Reflect.get(doc, 'auth'));
    // A provider checks redirect_uri on every authorization: a client registered for another callback (the local
    // engine's port changes each launch) has to be registered again rather than reused.
    if (provided === undefined && mode !== 'provided' && previous !== undefined && previous.issuer === server.issuer && previous.redirectUri === redirectUri) {
      client = { clientId: previous.clientId, ...(previous.clientSecret === undefined ? {} : { clientSecret: previous.clientSecret }) };
    } else {
      // Provided (ours, registered with the provider) -> CIMD (a document we host) -> DCR -> a clear refusal (MCP authorization).
      const cimdUrl = clientMetadataUrl(deps);
      const chosen = chooseClient({ server, provided, ...(mode === undefined ? {} : { mode }), ...(cimdUrl === undefined ? {} : { cimdUrl }) });
      client = chosen.kind === 'provided' ? chosen.client : chosen.kind === 'cimd' ? { clientId: chosen.clientId } : await registerClient(server, redirectUri, deps.fetchImpl);
    }
  } catch (error) {
    throw failure(error);
  }

  // Scopes: what the app's package documents, else what the 401 challenge asked for, else the metadata's `scopes_supported`; a step-up
  // (a 403 insufficient_scope the manager recorded) adds the scope that was missing, at most STEP_UP_LIMIT times for one connection.
  const stepUps = Number(Reflect.get(doc, 'stepUps') ?? 0);
  const needsScope = typeof Reflect.get(doc, 'needsScope') === 'string' && stepUps < STEP_UP_LIMIT ? String(Reflect.get(doc, 'needsScope')) : undefined;
  const documented = Array.isArray(scopes) && scopes.every((scope) => typeof scope === 'string') ? scopes.map(String) : [];
  const scopeList = mergeScopes(documented.length > 0 ? documented : probe.challengeScope ?? server.scopesSupported, needsScope);
  const scopeValue: Record<string, string> = scopeList.length === 0 ? {} : { scope: scopeList.join(' ') };
  if (needsScope !== undefined) await scoped.patch('connections', connectionId, { needsScope: null, stepUps: stepUps + 1 } as never);

  const { state, nonceHash } = createState(connectionId);
  const pkce = createPkce();
  const now = Date.now();
  const configuredParams = configuredClientFor(server.issuer, deps.env, names)?.extraAuthParams;
  const extraAuthParams: Record<string, string> | undefined = configuredParams === undefined && Object.keys(scopeValue).length === 0 ? undefined : { ...configuredParams, ...scopeValue };
  // A new authorization starts clean: tokens from an earlier session are dropped, the client is kept.
  const record: OAuthRecord = {
    issuer: server.issuer,
    authorizationEndpoint: server.authorizationEndpoint,
    tokenEndpoint: server.tokenEndpoint,
    resource: endpoint,
    clientId: client.clientId,
    redirectUri,
    ...(client.clientSecret === undefined ? {} : { clientSecret: client.clientSecret }),
    ...(extraAuthParams === undefined ? {} : { extraAuthParams }),
    pending: { nonceHash, verifier: pkce.verifier, redirectUri, ...(returnUrl === undefined ? {} : { returnUrl }), expiresAt: new Date(now + PENDING_TTL_MS).toISOString() },
  };
  const updated = await scoped.patch('connections', connectionId, { auth: sealOAuth(record) } as never);
  const authorizationUrl = buildAuthorizationUrl({
    server,
    clientId: client.clientId,
    redirectUri,
    state,
    challenge: pkce.challenge,
    resource: endpoint,
    ...(extraAuthParams === undefined ? {} : { extraAuthParams }),
  });
  return { connection: connectionSchema.parse(updated), authorizationUrl };
}

async function verifyServer(url: string, accessToken: string, fetchImpl: typeof fetch): Promise<boolean> {
  const client = new McpClient(
    () => new HttpMcpTransport({ url, fetchImpl, authorize: async () => 'Bearer ' + accessToken }),
  );
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * The browser callback. Returns the connection it concerned, the outcome and where to send the browser (the return URL
 * the connect request chose, else MCP_OAUTH_RETURN_URL); every check that fails before the owner is known is a 400
 * with no detail about which part was wrong.
 */
export async function completeMcpAuthorization(
  deps: McpAuthorizationDeps,
  input: { state: string; code?: string; error?: string },
): Promise<{ connectionId: string; ownerId: string; status: 'connected' | 'error'; returnUrl: string }> {
  const invalid = () => new McpAuthorizationError(400, 'MCP_OAUTH_STATE_INVALID', 'The authorization link is invalid or has expired');
  const parsed = parseState(input.state);
  if (parsed === undefined) throw invalid();
  const found = await deps.store.get('connections', parsed.connectionId);
  const ownerId = found === null ? undefined : Reflect.get(found, 'ownerId');
  if (found === null || found.kind !== 'mcp' || typeof ownerId !== 'string') throw invalid();
  const record = openOAuth(Reflect.get(found, 'auth'));
  const pending = record?.pending;
  if (record === undefined || pending === undefined) throw invalid();
  const now = Date.now();
  if (Date.parse(pending.expiresAt) <= now || !nonceMatches(parsed.nonce, pending.nonceHash)) throw invalid();
  pruneRedeemed(now);
  if (redeemed.has(pending.nonceHash)) throw invalid();
  redeemed.set(pending.nonceHash, Date.parse(pending.expiresAt));

  const scoped = ownerScoped(deps.store, ownerId);
  const returnUrl = pending.returnUrl ?? deps.returnUrl;
  const { pending: _redeemed, ...withoutPending } = record;
  // Clear the pending authorization before any exchange: a second callback finds nothing to redeem.
  await scoped.patch('connections', parsed.connectionId, { auth: sealOAuth(withoutPending) } as never);
  if (input.error !== undefined || input.code === undefined) {
    return { connectionId: parsed.connectionId, ownerId, status: 'error', returnUrl };
  }

  const server = { issuer: record.issuer, authorizationEndpoint: record.authorizationEndpoint, tokenEndpoint: record.tokenEndpoint };
  let tokens;
  try {
    tokens = await exchangeCode({
      server,
      client: { clientId: record.clientId, ...(record.clientSecret === undefined ? {} : { clientSecret: record.clientSecret }) },
      code: input.code,
      verifier: pending.verifier,
      redirectUri: pending.redirectUri,
      resource: record.resource,
      fetchImpl: deps.fetchImpl,
    });
  } catch (error) {
    if (error instanceof McpOAuthError) return { connectionId: parsed.connectionId, ownerId, status: 'error', returnUrl };
    throw error;
  }
  const authorized: OAuthRecord = {
    ...withoutPending,
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
    ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
    ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
  };
  const connected = await verifyServer(record.resource, tokens.accessToken, deps.fetchImpl);
  // enabled is set by the user's own authorization; a previous disconnect must not block the new session.
  await scoped.patch('connections', parsed.connectionId, {
    auth: sealOAuth(authorized),
    enabled: true,
    status: connected ? 'connected' : 'error',
    ...(connected ? { connectedAt: new Date().toISOString() } : {}),
  } as never);
  return { connectionId: parsed.connectionId, ownerId, status: connected ? 'connected' : 'error', returnUrl };
}

/** The URL the browser is sent to after the callback, carrying the connection id and outcome only. */
export function returnLocation(returnUrl: string, connectionId: string, status: 'connected' | 'error'): string {
  const url = new URL(returnUrl);
  url.searchParams.set('connection', connectionId);
  url.searchParams.set('status', status);
  return url.toString();
}

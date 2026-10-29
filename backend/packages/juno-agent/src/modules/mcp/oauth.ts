// MCP authorization (OAuth 2.1 + PKCE S256) for a remote streamable-HTTP server: probe for a 401, discover
// the protected resource (RFC 9728) and authorization server (RFC 8414, OIDC fallback), register a client
// (RFC 7591) or use one configured in the environment, and exchange/refresh tokens with the RFC 8707
// `resource` parameter. Pure over an injected fetch; no token or token-endpoint body ever reaches an error.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { decryptSecret, encryptSecret } from '../../contracts/secrets.js';
import { UnsafeTargetError } from '../tools/net/safeFetch.js';
import { MCP_PROTOCOL_VERSION } from './protocol.js';
import { parseChallenge } from './challenge.js';

const CLIENT_INFO = { name: 'Vomu', version: '1.0.0' };
const FETCH_TIMEOUT_MS = 15_000;

/** Stable reason codes the API maps to HTTP statuses; the message is safe to show to a client. */
export class McpOAuthError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'McpOAuthError';
  }
}

/**
 * A request the outbound guard refused (private or non-http target) is its own code, never a generic
 * reachability failure. Anything else keeps the caller's code.
 */
function failedRequest(error: unknown, code: string, message: string): McpOAuthError {
  if (error instanceof UnsafeTargetError) return new McpOAuthError('MCP_URL_BLOCKED', error.message);
  return new McpOAuthError(code, message);
}

export interface AuthorizationServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** The server accepts a client metadata document URL as `client_id` (CIMD). */
  clientIdMetadataDocumentSupported?: true;
  /** The protected resource metadata's `scopes_supported`: what to ask for when the 401 challenge names none. */
  scopesSupported?: string[];
}

export interface ClientRegistration {
  clientId: string;
  clientSecret?: string;
  /** Extra authorize parameters a provider needs (e.g. Google's refresh-token grant). */
  extraAuthParams?: Record<string, string>;
}

/**
 * Microsoft's `common` authority cannot go through the metadata checks below: its OIDC document names a templated
 * issuer (`https://login.microsoftonline.com/{tenantid}/v2.0`, id tokens carry the signed-in tenant's issuer) that never
 * equals `common`, and it is served at `<authority>/.well-known/openid-configuration` rather than the RFC 8414 path.
 * We only need an access token for Graph, never an id token, so the authorization server is a fixed, documented one:
 * this issuer string (what our hosted resource metadata names) maps to Microsoft's v2.0 endpoints. Nothing is fetched
 * and no other issuer is treated this way; every other provider still has to prove its issuer and advertise S256.
 */
export const MICROSOFT_ISSUER = 'https://login.microsoftonline.com/common/v2.0';
const MICROSOFT_AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const STATIC_SERVERS: ReadonlyMap<string, AuthorizationServer> = new Map([
  [MICROSOFT_ISSUER, { issuer: MICROSOFT_ISSUER, authorizationEndpoint: MICROSOFT_AUTHORITY + '/authorize', tokenEndpoint: MICROSOFT_AUTHORITY + '/token' }],
]);

/** Microsoft's v2.0 endpoints reject the RFC 8707 `resource` parameter (AADSTS901002); the resource is implied by the scopes. */
const sendsResource = (server: AuthorizationServer): boolean => server.issuer !== MICROSOFT_ISSUER;

/** Providers without dynamic client registration: the client comes from the environment, keyed by issuer. */
const CONFIGURED_CLIENTS: ReadonlyArray<{
  issuer: string;
  idEnv: string;
  secretEnv: string;
  extraAuthParams: Record<string, string>;
  /**
   * The loopback host a desktop client of this provider has to be sent. Microsoft ignores the port only for
   * `localhost` and matches the path; an IP literal has to match port and path exactly, which a client on a random
   * port cannot. Google documents `127.0.0.1` with any port, so its base is used as given.
   */
  loopbackHost?: string;
}> = [
  {
    issuer: 'https://accounts.google.com',
    idEnv: 'GOOGLE_OAUTH_CLIENT_ID',
    secretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
  // Microsoft identity platform, multi-tenant `common` authority (work/school and personal accounts); see MICROSOFT_AUTHORITY.
  { issuer: MICROSOFT_ISSUER, idEnv: 'MICROSOFT_CLIENT_ID', secretEnv: 'MICROSOFT_CLIENT_SECRET', extraAuthParams: {}, loopbackHost: 'localhost' },
  // Strava's own MCP: dynamic registration exists but only accepts a few known clients' redirect URIs, so ours is registered by hand.
  { issuer: 'https://www.strava.com/mcp-issuer', idEnv: 'STRAVA_CLIENT_ID', secretEnv: 'STRAVA_CLIENT_SECRET', extraAuthParams: {} },
  // Salesforce hosted MCP: the client is the External Client App Juno's operator registers (an org's admin installs it); no extra authorize parameters.
  { issuer: 'https://login.salesforce.com', idEnv: 'SALESFORCE_CLIENT_ID', secretEnv: 'SALESFORCE_CLIENT_SECRET', extraAuthParams: {} },
  // Dropbox's remote MCP registers only a trusted list of clients dynamically (we are not on it): our own Dropbox app, with `<PUBLIC_URL>/oauth/mcp/callback` as a redirect URI.
  // `token_access_type=offline` is what makes Dropbox return a refresh token (https://docs.dropboxapi.com/dropbox-api/docs/oauth).
  { issuer: 'https://www.dropbox.com', idEnv: 'DROPBOX_CLIENT_ID', secretEnv: 'DROPBOX_CLIENT_SECRET', extraAuthParams: { token_access_type: 'offline' } },
];

/** The NAMES of the deployment secrets holding a provided client's id and secret; an app package gives them, never the values. */
export interface ClientSecretNames {
  idName: string;
  secretName?: string;
}

/**
 * The environment-configured client for an issuer, or undefined when that provider is not configured. The deployment secrets are the table's
 * (by issuer) unless an app package names its own (`names`); the provider's extra authorize parameters still come from the table.
 */
export function configuredClientFor(issuer: string, env: Record<string, string | undefined>, names?: ClientSecretNames): ClientRegistration | undefined {
  const entry = CONFIGURED_CLIENTS.find((candidate) => candidate.issuer === issuer.replace(/\/+$/, ''));
  const idName = names?.idName ?? entry?.idEnv;
  if (idName === undefined) return undefined;
  const clientId = env[idName];
  if (clientId === undefined || clientId === '') return undefined;
  const secretName = names === undefined ? entry?.secretEnv : names.secretName;
  const secret = secretName === undefined ? undefined : env[secretName];
  return {
    clientId,
    ...(secret === undefined || secret === '' ? {} : { clientSecret: secret }),
    extraAuthParams: entry?.extraAuthParams ?? {},
  };
}

/**
 * The origin the provider's callback has to land on. Only a loopback base can change, and only for a provider that
 * matches its redirect URIs by host and path alone; a public deployment's base is returned unchanged.
 */
export function loopbackRedirectBase(base: string, issuer: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return base;
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (!loopback) return base;
  const wanted = CONFIGURED_CLIENTS.find((candidate) => candidate.issuer === issuer.replace(/\/+$/, ''))?.loopbackHost;
  if (wanted === undefined || url.hostname === wanted) return base;
  url.hostname = wanted;
  return url.origin;
}

/** HTTPS everywhere, except loopback http (local development and the test fixture). */
export function requireSecureUrl(raw: string, what: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpOAuthError('MCP_OAUTH_DISCOVERY', what + ' is not a valid URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return raw;
  throw new McpOAuthError('MCP_OAUTH_DISCOVERY', what + ' must use https');
}

function wellKnown(base: string, suffix: string, pathAware: boolean): string {
  const url = new URL(base);
  const path = pathAware && url.pathname !== '/' ? url.pathname.replace(/\/+$/, '') : '';
  return url.origin + '/.well-known/' + suffix + path;
}

/** Metadata GETs follow redirects; the guarded fetch re-checks every hop. */
async function fetchJson(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<unknown | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof UnsafeTargetError) throw new McpOAuthError('MCP_URL_BLOCKED', error.message);
    throw error;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  return response.json().catch(() => undefined);
}

/** The `resource_metadata` URL from a 401 WWW-Authenticate challenge, when the server names one. */
export function resourceMetadataFromChallenge(header: string | null): string | undefined {
  return parseChallenge(header).resourceMetadata;
}

export interface ProbeResult {
  /** The server answered without a credential: no authorization is needed. */
  open: boolean;
  resourceMetadataUrl?: string;
  /** The scope the 401 challenge asks the sign-in to request (MCP authorization: tried first, before the metadata's `scopes_supported`). */
  challengeScope?: string;
}

/** One unauthenticated initialize: 2xx means open, 401 means authorize, anything else is unreachable. */
export async function probeMcpServer(url: string, fetchImpl: typeof fetch): Promise<ProbeResult> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 'probe',
    method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
  });
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw failedRequest(error, 'MCP_UNREACHABLE', 'The MCP server could not be reached');
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401) {
    const challenge = parseChallenge(response.headers.get('www-authenticate'));
    return {
      open: false,
      ...(challenge.resourceMetadata === undefined ? {} : { resourceMetadataUrl: challenge.resourceMetadata }),
      ...(challenge.scope === undefined ? {} : { challengeScope: challenge.scope }),
    };
  }
  if (response.ok) return { open: true };
  throw new McpOAuthError('MCP_UNREACHABLE', 'The MCP server returned HTTP ' + String(response.status));
}

const protectedResourceSchema = z.object({
  resource: z.string().min(1),
  authorization_servers: z.array(z.string().min(1)).min(1),
  scopes_supported: z.array(z.string()).optional(),
});
const authServerSchema = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: z.string().min(1),
  token_endpoint: z.string().min(1),
  registration_endpoint: z.string().min(1).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  /** draft-ietf-oauth-client-id-metadata-document: the server accepts an HTTPS URL as `client_id`. */
  client_id_metadata_document_supported: z.boolean().optional(),
});

/** Trailing slashes are not significant in an issuer or resource identifier. */
function sameIdentifier(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/**
 * RFC 9728 then RFC 8414: the MCP server names its authorization server; the AS metadata must
 * advertise S256 PKCE. Candidate URLs are tried in the spec's order, path-aware form first.
 * Both documents must name what was asked for: the protected resource must be this MCP server
 * (RFC 9728 §3.3) and the AS metadata's issuer must be the authorization server it was fetched from
 * (RFC 8414 §3.3). Without that check a hostile server could point discovery at its own AS.
 */
export async function discoverAuthorizationServer(
  mcpUrl: string,
  resourceMetadataUrl: string | undefined,
  fetchImpl: typeof fetch,
): Promise<AuthorizationServer> {
  const prmCandidates = resourceMetadataUrl === undefined
    ? [wellKnown(mcpUrl, 'oauth-protected-resource', true), wellKnown(mcpUrl, 'oauth-protected-resource', false)]
    : [requireSecureUrl(resourceMetadataUrl, 'resource metadata URL')];
  let protectedResource: z.infer<typeof protectedResourceSchema> | undefined;
  for (const candidate of prmCandidates) {
    const parsed = protectedResourceSchema.safeParse(await fetchJson(fetchImpl, candidate));
    if (parsed.success) {
      protectedResource = parsed.data;
      break;
    }
  }
  if (protectedResource !== undefined && !sameIdentifier(protectedResource.resource, mcpUrl)) {
    throw new McpOAuthError('MCP_OAUTH_DISCOVERY', 'The resource metadata describes a different MCP server');
  }
  // Legacy servers without RFC 9728 metadata keep their AS at the MCP origin.
  const issuer = requireSecureUrl(protectedResource?.authorization_servers[0] ?? new URL(mcpUrl).origin, 'authorization server');
  const fixed = STATIC_SERVERS.get(issuer.replace(/\/+$/, ''));
  if (fixed !== undefined) return fixed;
  const scopesSupported = protectedResource?.scopes_supported;
  const asCandidates = [
    wellKnown(issuer, 'oauth-authorization-server', true),
    wellKnown(issuer, 'oauth-authorization-server', false),
    wellKnown(issuer, 'openid-configuration', true),
  ];
  for (const candidate of [...new Set(asCandidates)]) {
    const parsed = authServerSchema.safeParse(await fetchJson(fetchImpl, candidate));
    if (!parsed.success) continue;
    const meta = parsed.data;
    if (!sameIdentifier(meta.issuer, issuer)) {
      throw new McpOAuthError('MCP_OAUTH_DISCOVERY', 'The authorization metadata names a different issuer');
    }
    const methods = meta.code_challenge_methods_supported;
    if (methods === undefined || !methods.includes('S256')) {
      throw new McpOAuthError('MCP_OAUTH_DISCOVERY', 'The authorization server does not advertise PKCE S256');
    }
    return {
      issuer,
      authorizationEndpoint: requireSecureUrl(meta.authorization_endpoint, 'authorization endpoint'),
      tokenEndpoint: requireSecureUrl(meta.token_endpoint, 'token endpoint'),
      ...(meta.registration_endpoint === undefined
        ? {}
        : { registrationEndpoint: requireSecureUrl(meta.registration_endpoint, 'registration endpoint') }),
      ...(meta.client_id_metadata_document_supported === true ? { clientIdMetadataDocumentSupported: true as const } : {}),
      ...(scopesSupported === undefined || scopesSupported.length === 0 ? {} : { scopesSupported }),
    };
  }
  throw new McpOAuthError('MCP_OAUTH_DISCOVERY', 'No authorization server metadata was found');
}

/** RFC 7591 dynamic registration for a public client bound to our fixed redirect URI. */
export async function registerClient(server: AuthorizationServer, redirectUri: string, fetchImpl: typeof fetch): Promise<ClientRegistration> {
  if (server.registrationEndpoint === undefined) {
    throw new McpOAuthError('MCP_OAUTH_NO_CLIENT', 'This provider needs a configured OAuth client; none is set for it');
  }
  let response: Response;
  try {
    response = await fetchImpl(server.registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_INFO.name,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (error) {
    throw failedRequest(error, 'MCP_OAUTH_REGISTRATION', 'Dynamic client registration failed');
  }
  const parsed = z.object({ client_id: z.string().min(1), client_secret: z.string().min(1).optional() })
    .safeParse(response.ok ? await response.json().catch(() => undefined) : undefined);
  if (!parsed.success) throw new McpOAuthError('MCP_OAUTH_REGISTRATION', 'Dynamic client registration was refused');
  return {
    clientId: parsed.data.client_id,
    ...(parsed.data.client_secret === undefined ? {} : { clientSecret: parsed.data.client_secret }),
  };
}

export type ClientChoice = { kind: 'provided'; client: ClientRegistration } | { kind: 'cimd'; clientId: string } | { kind: 'dcr' };

/**
 * The client to sign in with, in the order the MCP authorization spec prefers: one we registered with the provider (`provided`), a client
 * metadata document we host (CIMD, when the server says it accepts one), dynamic registration (DCR, when it has a registration endpoint);
 * otherwise a clear refusal. `mode` forces one kind (an app package's `oauth.client`) and refuses when the server cannot do it.
 */
export function chooseClient(input: { server: AuthorizationServer; provided: ClientRegistration | undefined; mode?: 'provided' | 'cimd' | 'dcr'; cimdUrl?: string }): ClientChoice {
  const { server, provided, mode, cimdUrl } = input;
  const cimd = server.clientIdMetadataDocumentSupported === true && cimdUrl !== undefined;
  if (mode === 'provided' || (mode === undefined && provided !== undefined)) {
    if (provided === undefined) throw new McpOAuthError('MCP_OAUTH_NO_CLIENT', 'This provider needs an OAuth client configured on this deployment; none is set for it');
    return { kind: 'provided', client: provided };
  }
  if (mode === 'cimd' || (mode === undefined && cimd)) {
    if (!cimd || cimdUrl === undefined) throw new McpOAuthError('MCP_OAUTH_CIMD_UNSUPPORTED', 'This provider does not accept a client metadata document, or this deployment has no public https address to host one at');
    return { kind: 'cimd', clientId: cimdUrl };
  }
  if (server.registrationEndpoint === undefined) {
    throw new McpOAuthError('MCP_OAUTH_NO_CLIENT', 'This provider accepts neither a client metadata document nor dynamic registration, and no OAuth client is configured for it');
  }
  return { kind: 'dcr' };
}

/** The client metadata document served at the CIMD client id URL (RFC-style public client; the redirect URIs are the callbacks of this deployment's allowed origins). */
export function clientMetadataDocument(clientId: string, redirectUris: readonly string[]): Record<string, unknown> {
  return {
    client_id: clientId,
    client_name: CLIENT_INFO.name,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function hashNonce(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

/** state = `<connectionId>.<nonce>`: the nonce is 256 random bits, stored only as its hash. */
export function createState(connectionId: string): { state: string; nonce: string; nonceHash: string } {
  const nonce = randomBytes(32).toString('base64url');
  return { state: connectionId + '.' + nonce, nonce, nonceHash: hashNonce(nonce) };
}

export function parseState(state: string): { connectionId: string; nonce: string } | undefined {
  const dot = state.lastIndexOf('.');
  if (dot <= 0 || dot === state.length - 1) return undefined;
  return { connectionId: state.slice(0, dot), nonce: state.slice(dot + 1) };
}

/** Constant-time comparison of a presented nonce against its stored hash. */
export function nonceMatches(nonce: string, storedHash: string): boolean {
  const a = Buffer.from(hashNonce(nonce), 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildAuthorizationUrl(input: {
  server: AuthorizationServer;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  resource: string;
  extraAuthParams?: Record<string, string>;
}): string {
  const url = new URL(input.server.authorizationEndpoint);
  const params: Record<string, string> = {
    ...input.extraAuthParams,
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    ...(sendsResource(input.server) ? { resource: input.resource } : {}),
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** Tokens as they are used at runtime; persisted only through the sealed form in `connections.ts`. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
  scope: z.string().optional(),
});

async function postToken(
  server: AuthorizationServer,
  form: Record<string, string>,
  clientSecret: string | undefined,
  fetchImpl: typeof fetch,
  now: number,
): Promise<TokenSet> {
  const body = new URLSearchParams(form);
  if (clientSecret !== undefined) body.set('client_secret', clientSecret);
  let response: Response;
  try {
    response = await fetchImpl(server.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (error) {
    throw failedRequest(error, 'MCP_OAUTH_TOKEN', 'The token endpoint could not be reached');
  }
  if (!response.ok) {
    // Only the OAuth error code is surfaced; the response body may echo credentials and is never kept.
    const reason = await response.json().then((value: unknown) => {
      const code = z.object({ error: z.string() }).safeParse(value);
      return code.success ? code.data.error : undefined;
    }).catch(() => undefined);
    throw new McpOAuthError(reason === 'invalid_grant' ? 'MCP_OAUTH_INVALID_GRANT' : 'MCP_OAUTH_TOKEN',
      'The token endpoint rejected the request' + (reason === undefined ? '' : ' (' + reason + ')'));
  }
  const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new McpOAuthError('MCP_OAUTH_TOKEN', 'The token response was not usable');
  return {
    accessToken: parsed.data.access_token,
    ...(parsed.data.refresh_token === undefined ? {} : { refreshToken: parsed.data.refresh_token }),
    ...(parsed.data.expires_in === undefined ? {} : { expiresAt: new Date(now + parsed.data.expires_in * 1000).toISOString() }),
    ...(parsed.data.scope === undefined ? {} : { scope: parsed.data.scope }),
  };
}

export function exchangeCode(input: {
  server: AuthorizationServer;
  client: ClientRegistration;
  code: string;
  verifier: string;
  redirectUri: string;
  resource: string;
  fetchImpl: typeof fetch;
  now?: number;
}): Promise<TokenSet> {
  return postToken(input.server, {
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
    client_id: input.client.clientId,
    ...(sendsResource(input.server) ? { resource: input.resource } : {}),
  }, input.client.clientSecret, input.fetchImpl, input.now ?? Date.now());
}

export function refreshTokens(input: {
  server: AuthorizationServer;
  client: ClientRegistration;
  refreshToken: string;
  resource: string;
  fetchImpl: typeof fetch;
  now?: number;
}): Promise<TokenSet> {
  return postToken(input.server, {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.client.clientId,
    ...(sendsResource(input.server) ? { resource: input.resource } : {}),
  }, input.client.clientSecret, input.fetchImpl, input.now ?? Date.now());
}

/**
 * A pending authorization: the nonce hash, the PKCE verifier and the redirect URI it was started with, and where
 * the browser goes after the callback when the client chose an allow-listed return URL (the iPhone app's scheme).
 */
export interface PendingAuthorization {
  nonceHash: string;
  verifier: string;
  redirectUri: string;
  returnUrl?: string;
  expiresAt: string;
}

/**
 * The OAuth record kept on a connection. Secrets are sealed (`enc:v1:`) on write and opened on read;
 * the connection's public projection never includes this object.
 */
export interface OAuthRecord {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  resource: string;
  clientId: string;
  clientSecret?: string;
  /**
   * The redirect URI this client was registered with. A provider checks it on every authorization, and the local
   * engine's callback port changes each launch, so a client registered for another redirect is not reused.
   */
  redirectUri?: string;
  extraAuthParams?: Record<string, string>;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  pending?: PendingAuthorization;
}

const sealedSchema = z.object({
  issuer: z.string().min(1),
  authorizationEndpoint: z.string().min(1),
  tokenEndpoint: z.string().min(1),
  resource: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  redirectUri: z.string().min(1).optional(),
  extraAuthParams: z.record(z.string(), z.string()).optional(),
  accessToken: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.string().optional(),
  scope: z.string().optional(),
  pending: z.object({ nonceHash: z.string(), verifier: z.string(), redirectUri: z.string(), returnUrl: z.string().optional(), expiresAt: z.string() }).optional(),
});

function sealed(value: string | undefined): string | undefined {
  return value === undefined ? undefined : encryptSecret(value);
}

/** The persisted form: every secret field is encrypted, so the row holds no plaintext credential. */
export function sealOAuth(record: OAuthRecord): Record<string, unknown> {
  const { clientSecret, accessToken, refreshToken, pending, ...rest } = record;
  return {
    ...rest,
    ...(clientSecret === undefined ? {} : { clientSecret: sealed(clientSecret) }),
    ...(accessToken === undefined ? {} : { accessToken: sealed(accessToken) }),
    ...(refreshToken === undefined ? {} : { refreshToken: sealed(refreshToken) }),
    ...(pending === undefined ? {} : { pending: { ...pending, verifier: sealed(pending.verifier) } }),
  };
}

/** Reads the persisted record; undefined when absent, throws SecretsError when a secret cannot be opened. */
export function openOAuth(stored: unknown): OAuthRecord | undefined {
  if (stored === undefined || stored === null) return undefined;
  const parsed = sealedSchema.safeParse(stored);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  const open = (secret: string | undefined): string | undefined => (secret === undefined ? undefined : decryptSecret(secret));
  const pending = value.pending === undefined
    ? undefined
    : { ...value.pending, verifier: decryptSecret(value.pending.verifier) };
  return {
    issuer: value.issuer,
    authorizationEndpoint: value.authorizationEndpoint,
    tokenEndpoint: value.tokenEndpoint,
    resource: value.resource,
    clientId: value.clientId,
    ...(value.clientSecret === undefined ? {} : { clientSecret: open(value.clientSecret) }),
    ...(value.redirectUri === undefined ? {} : { redirectUri: value.redirectUri }),
    ...(value.extraAuthParams === undefined ? {} : { extraAuthParams: value.extraAuthParams }),
    ...(value.accessToken === undefined ? {} : { accessToken: open(value.accessToken) }),
    ...(value.refreshToken === undefined ? {} : { refreshToken: open(value.refreshToken) }),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
    ...(value.scope === undefined ? {} : { scope: value.scope }),
    ...(pending === undefined ? {} : { pending }),
  };
}

/** The server view of an OAuth record, for the token source: the endpoints and client it refreshes with. */
export function serverOf(record: OAuthRecord): AuthorizationServer {
  return { issuer: record.issuer, authorizationEndpoint: record.authorizationEndpoint, tokenEndpoint: record.tokenEndpoint };
}

export function clientOf(record: OAuthRecord): ClientRegistration {
  return {
    clientId: record.clientId,
    ...(record.clientSecret === undefined ? {} : { clientSecret: record.clientSecret }),
  };
}

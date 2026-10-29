/**
 * Public API gateway: owns auth and the app data, and forwards the agent surface.
 *
 * Public surface: /healthz, /auth/info, /auth/*, the hook ingress and the MCP OAuth callback
 * (/oauth/mcp/callback, which verifies its own state) need no session. Every /v1 request is
 * resolved to an owner through the injected account session first; anonymous requests are
 * rejected here and never reach the private service. Upstream the gateway speaks as itself
 * (service bearer) and states the authoritative owner, so the private agentd never sees user
 * credentials. App-owned routes (settings, integrations, library, activity) are served here and
 * never forwarded; only the exact method+path pairs in routes/agentd-routes.ts cross the boundary.
 * Entry stays in this file: createApiApp is the public factory.
 */
import { Hono } from 'hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { cors } from 'hono/cors';
import { NotFoundError } from '@agent-desktop/contracts';
import type { BlobStore, Store } from '@agent-desktop/contracts';
import { createMcpManager, guardedFetch } from '@agent-desktop/contracts/mcp';
import { createAgentdCatalog, resolveCatalog, validateCatalog, type CatalogEntry } from './modules/connector-catalog.js';
import type { GoogleMcpDeps } from './modules/google-mcp.js';
import type { HevyMcpDeps } from './modules/hevy-mcp.js';
import { registerGoogleMcp } from './routes/google-mcp.js';
import { registerSgMcp } from './routes/sg-mcp.js';
import { registerAdminApps } from './routes/admin.js';
import type { SgMcpDeps } from './modules/sg-mcp.js';
import type { ConnectorsDeps } from './modules/connectors.js';
import { createComposioClient, type ComposioClient } from './modules/composio.js';
import { registerComposioCallback } from './routes/composio.js';
import type { AuthInfo } from './account-auth.js';
import { forwardToAgentd, isClientAbort } from './proxy.js';
import { createMediaRewriter, registerMediaRoute, type MediaCache } from './media-proxy.js';
import { registerSiteIconRoute, siteIconUrlFor, type SiteIconCache } from './site-icon.js';
import type { ForwardDeps } from './proxy.js';
import { requestOwner, requestOwnerEmail, setRequestOwner, setRequestOwnerEmail } from './owner.js';
import { registerAppRoutes } from './routes/index.js';
import type { SpaceRoutesDeps } from './routes/spaces.js';
import { registerEdgeTlsCheck, type EdgeTlsDeps } from './routes/edge.js';
import { registerHookIngress } from './routes/hooks.js';
import { registerChannelIngress } from './routes/channels.js';
import { registerMcpCallback } from './routes/mcp-authorization.js';
import { createConnectionsChanged, notifyAfterConnectionWrite } from './modules/capability-recheck.js';
import type { McpAuthorizationDeps } from './modules/mcp-authorization.js';
import { AGENTD_ROUTES } from './routes/agentd-routes.js';
import { revokeOwnerHosted } from './modules/spaces-hosted.js';
import { createAgentdModelCatalogLoader, type ModelCatalogLoader, type SettingsUpdater } from './modules/settings.js';
import { createAgentdModelProviderClient, type ModelProviderCatalogClient } from './modules/model-providers.js';
import { createLogger } from '@agent-desktop/log';
import { createWebStaticHandler } from './web-static.js';
import { registerAgentAvatarRoute, registerBrandIconRoute } from './brand-icons.js';

const log = createLogger({ service: 'api' });

/** Account session surface the gateway authenticates with (Better Auth in main.ts). */
export interface ApiAuth {
  info: AuthInfo;
  handle: (request: Request) => Promise<Response>;
  resolve: (request: Request) => Promise<{ ownerId: string; email?: string } | null>;
}

export interface ApiAppDeps {
  auth: ApiAuth;
  /** Private agentd base URL (for example http://127.0.0.1:8788). */
  agentdUrl: string;
  /** Service bearer sent upstream; never derived from the incoming request. */
  internalToken: string;
  /** Bearer for the operator's admin path (`/admin/v1/apps`, BACKEND 10.18); empty or absent switches that path off. */
  adminToken?: string;
  /** Injectable for tests; defaults to the global fetch with no retries. */
  fetch?: typeof fetch;
  /** Public base URL of this gateway (BETTER_AUTH_URL); absolute webhook URLs are built from it. Absent uses the request origin. */
  publicUrl?: string;
  /** Durable owner-scoped store for the app-owned collections; absent keeps the app forward-only. */
  store?: Store;
  /** Where file bytes live (uploads, downloads, artifact files); required with `store`. */
  blobs?: BlobStore;
  /** Durable settings writer; absent uses the store transaction (tests and in-process setups). */
  settingsUpdater?: SettingsUpdater;
  /** Catalog loader for model validation; defaults to the gateway agentd fetch. */
  modelsLoader?: ModelCatalogLoader;
  providerClient?: ModelProviderCatalogClient;
  /** The platform default endpoint (MODEL_*) is configured for this runtime. */
  platformDefault?: boolean;
  /** Transport for the ChatGPT sign-in token exchange (tests inject a fixture). */
  oauthFetch?: typeof fetch;
  /**
   * Dependency readiness probe run on every /healthz request. Absent keeps /healthz a plain
   * liveness check (in-process factory tests and setups without wired dependencies); production
   * injects the bounded auth-store/agentd probe from readiness.ts.
   */
  readiness?: () => Promise<void>;
  /** MCP connect flow: fallback redirect target, environment for configured OAuth clients, and an injectable fetch. */
  /** Connector catalog override (tests pin one, e.g. pointing an entry at a loopback fixture); defaults to the catalog agentd built from its plugins. */
  connectorCatalog?: readonly CatalogEntry[];
  mcpOAuth?: { returnUrl?: string; appReturnUrls?: string[]; env?: Record<string, string | undefined>; fetch?: typeof fetch };
  /** Composio (BACKEND 10.18.3). Absent: built from COMPOSIO_API_KEY (and COMPOSIO_BASE_URL) when the key is set; no key, no Composio apps. Tests inject a client. */
  composio?: ComposioClient;
  /** The Google MCP servers hosted here (Gmail, Calendar, Drive, YouTube, Tasks): tests point the issuer and the Google APIs at a fixture. */
  googleMcp?: Omit<GoogleMcpDeps, 'publicUrl'>;
  /** Singapore data servers (tests inject fetch, env and the clock). */
  sgMcp?: SgMcpDeps;
  /** The Hevy MCP server hosted here: tests point it at a fake Hevy. */
  hevyMcp?: HevyMcpDeps;
  /** Origin that serves HTML artifacts and the HMAC key for their URLs (ARTIFACT_HOST, ARTIFACT_URL_SECRET); absent: no render URLs. */
  artifactOrigin?: { origin: string; secret: string };
  /** Spaces (BACKEND 5.12): the preview domain, the key that signs open links and the session cookie, and computerd for status; absent: no space routes. */
  spaces?: SpaceRoutesDeps;
  /** Hosts the edge may get certificates for (`/v1/edge/tls-check`); absent: no check route. */
  edge?: EdgeTlsDeps;
  /** Browser origins allowed to call the API with credentials; absent: the web dev server, the desktop shell and `null` (file pages). */
  corsOrigins?: string[];
  /** Absolute path of the built web app directory (from the frontend repository) (WEB_DIST); absent serves no web files. */
  webDist?: string;
  /** The image proxy (BACKEND 5.13): signing key, disk cache, this gateway's public origin and the edge TLS scheme (EDGE_SCHEME); absent leaves external image URLs as they are and no media route. */
  media?: { key: Buffer; cache: MediaCache; origin: string; edgeScheme?: 'http' | 'https' };
  /** The site-icon proxy (BACKEND 5.13): an approval's `platform.host` gets a signed `iconUrl` (rewritten together with media URLs, so it needs `media` too); absent adds no icon and no route. */
  siteIcon?: { key: Buffer; cache: SiteIconCache; origin: string };
}

async function resolveOwner(
  c: Context,
  next: Next,
  resolve: ApiAuth['resolve'],
): Promise<Response | void> {
  let identity: { ownerId: string; email?: string } | null;
  try {
    identity = await resolve(c.req.raw);
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing session' } }, 401);
  }
  if (!identity) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing session' } }, 401);
  }
  setRequestOwner(c, identity.ownerId);
  if (identity.email) setRequestOwnerEmail(c, identity.email);
  return next();
}

/** Only an app install (a chat platform looks the owner up by it) needs the owner's email; nothing else gets it. */
function connectsChannel(c: Context): boolean {
  return c.req.method === 'POST' && /^\/v1\/apps\/[^/]+\/install$/.test(c.req.path);
}

export function createApiApp(deps: ApiAppDeps): Hono {
  const app = new Hono();
  const forwardDeps: ForwardDeps = {
    agentdUrl: deps.agentdUrl,
    internalToken: deps.internalToken,
    fetchFn: deps.fetch ?? fetch,
    ...(deps.media ? { media: createMediaRewriter({ ...deps.media, ...(deps.siteIcon ? { siteIconUrl: siteIconUrlFor(deps.siteIcon) } : {}) }) } : {}),
  };
  const authenticate: MiddlewareHandler = (c, next) => resolveOwner(c, next, deps.auth.resolve);

  // Unauthenticated and before CORS: the edge's on-demand TLS `ask` call carries no session.
  if (deps.edge) registerEdgeTlsCheck(app, deps.edge);

  app.use(
    '*',
    cors({
      // The desktop dev server runs on its own port (JUNO_DESKTOP_PORT) so the web dev server can keep 5199.
      origin: deps.corsOrigins ?? [
        'http://localhost:5199',
        'http://127.0.0.1:5199',
        ...(process.env.JUNO_DESKTOP_PORT === undefined ? [] : [`http://localhost:${process.env.JUNO_DESKTOP_PORT}`]),
        'null',
        'electron://app',
      ],
      credentials: true,
    }),
  );

  app.get('/healthz', async (c) => {
    if (deps.readiness) {
      try {
        await deps.readiness();
      } catch {
        // Dependency failures stay private: the caller only learns the gateway is not ready.
        return c.json({ status: 'unavailable', timestamp: new Date().toISOString() }, 503);
      }
    }
    return c.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/auth/info', (c) => c.json(deps.auth.info));

  app.all('/auth/*', (c) => deps.auth.handle(c.req.raw));

  // The one /v1 route open to callers without a login session: it verifies the routine's webhook
  // secret itself. Registered before the session middleware; an unverified call never falls through.
  if (deps.store) registerHookIngress(app, { store: deps.store, forward: forwardDeps });

  // The platform channel ingress (CH1): it verifies the channel's platform secret itself.
  // Registered before the session middleware like the hook ingress; nothing else under /v1/channels
  // is public, so an unverified call never falls through.
  if (deps.store) registerChannelIngress(app, { store: deps.store, forward: forwardDeps });

  const connectionsChanged = createConnectionsChanged({ agentdUrl: deps.agentdUrl, internalToken: deps.internalToken, fetchFn: deps.fetch ?? fetch });
  // MCP connect: the OAuth callback is a browser redirect with no session, so it joins the public surface.
  const mcpAuthorization: McpAuthorizationDeps | undefined = deps.store
    ? {
        store: deps.store,
        ...(deps.publicUrl === undefined ? {} : { publicUrl: deps.publicUrl }),
        returnUrl: deps.mcpOAuth?.returnUrl ?? process.env.MCP_OAUTH_RETURN_URL ?? 'http://localhost:5199/connectors',
        appReturnUrls: deps.mcpOAuth?.appReturnUrls ?? (process.env.MCP_OAUTH_APP_RETURN_URLS ?? 'juno://connectors').split(',').map((url) => url.trim()).filter((url) => url !== ''),
        env: deps.mcpOAuth?.env ?? process.env,
        // Outbound MCP traffic (discovery, DCR, tokens, the probe) goes through the private-network guard.
        fetchImpl: deps.mcpOAuth?.fetch ?? guardedFetch,
        connectionsChanged,
      }
    : undefined;
  if (mcpAuthorization) registerMcpCallback(app, mcpAuthorization);
  // Hosted Google MCP servers (BACKEND 10.15): public like the callback; the caller's Google token is the credential.
  const oauthEnv = deps.mcpOAuth?.env ?? process.env;
  const googleMcp: GoogleMcpDeps | undefined = deps.publicUrl === undefined
    ? undefined
    : { publicUrl: deps.publicUrl, internalToken: deps.internalToken, ...deps.googleMcp };
  if (googleMcp) registerSgMcp(app, { internalToken: deps.internalToken, ...deps.sgMcp });
  if (googleMcp) registerGoogleMcp(app, googleMcp, deps.hevyMcp);
  // The catalog is agentd's (its loaded plugins'); tests may pin a fixed one.
  if (deps.connectorCatalog !== undefined) validateCatalog(deps.connectorCatalog);
  const fixed = deps.connectorCatalog;
  const agentdCatalog = fixed === undefined ? createAgentdCatalog({ agentdUrl: deps.agentdUrl, internalToken: deps.internalToken, fetchFn: deps.fetch ?? fetch }) : undefined;
  const catalog = async (): Promise<CatalogEntry[]> => resolveCatalog(fixed ?? (await agentdCatalog?.()) ?? [], deps.publicUrl, oauthEnv);
  const held = async (): Promise<CatalogEntry[]> => resolveCatalog(fixed ?? (await agentdCatalog?.held()) ?? [], deps.publicUrl, oauthEnv);
  const composioKey = oauthEnv.COMPOSIO_API_KEY;
  const composio = deps.composio ?? (composioKey === undefined || composioKey === '' ? undefined : createComposioClient({ apiKey: composioKey, fetchImpl: deps.fetch ?? fetch, ...(oauthEnv.COMPOSIO_BASE_URL === undefined || oauthEnv.COMPOSIO_BASE_URL === '' ? {} : { baseUrl: oauthEnv.COMPOSIO_BASE_URL }) }));
  const connectors: ConnectorsDeps | undefined = mcpAuthorization
    ? { authorization: mcpAuthorization, catalog, held, manager: createMcpManager({ fetchImpl: mcpAuthorization.fetchImpl }), ...(composio === undefined ? {} : { composio }) }
    : undefined;
  // The browser comes back from Composio's login page here (no session; the state it carries is the only credential).
  if (connectors?.composio !== undefined && mcpAuthorization) registerComposioCallback(app, { store: mcpAuthorization.store, composio: connectors.composio, catalog: held, returnUrl: mcpAuthorization.returnUrl, connectionsChanged });
  // The operator's path to the app catalog: its own secret, before the session check (BACKEND 10.18).
  registerAdminApps(app, { adminToken: deps.adminToken ?? '', agentdUrl: deps.agentdUrl, internalToken: deps.internalToken, fetchFn: deps.fetch ?? fetch, changed: () => agentdCatalog?.invalidate() });

  // Signed image URLs carry their own credential, so <img> works cross-origin without a session.
  if (deps.media) registerMediaRoute(app, deps.media);
  if (deps.siteIcon) registerSiteIconRoute(app, deps.siteIcon);
  // Brand logos are public static files: registered before the session check.
  registerBrandIconRoute(app);
  registerAgentAvatarRoute(app);

  app.use('/v1/*', authenticate);
  // An app was added or removed: routines that need or lost an app are re-checked in agentd.
  app.use('/v1/apps/*', notifyAfterConnectionWrite(connectionsChanged));

  // App-owned routes. Without a store the app stays forward-only, so these stay unmapped (404)
  // instead of silently serving writes from an in-memory fallback.
  if (deps.store) {
    if (deps.blobs === undefined) throw new Error('createApiApp: blobs is required with store');
    const modelsLoader =
      deps.modelsLoader ??
      createAgentdModelCatalogLoader({
        agentdUrl: deps.agentdUrl,
        internalToken: deps.internalToken,
        fetchFn: deps.fetch ?? fetch,
      });
    const providerClient =
      deps.providerClient ??
      createAgentdModelProviderClient({ agentdUrl: deps.agentdUrl, internalToken: deps.internalToken, fetchFn: deps.fetch ?? fetch });
    registerAppRoutes(app, { store: deps.store, blobs: deps.blobs, settingsUpdater: deps.settingsUpdater, modelsLoader, providerClient, platformDefault: deps.platformDefault ?? false, ...(deps.oauthFetch ? { oauthFetch: deps.oauthFetch } : {}), publicUrl: deps.publicUrl, ...(deps.artifactOrigin ? { artifactOrigin: deps.artifactOrigin } : {}), ...(deps.spaces ? { spaces: deps.spaces } : {}), ...(connectors ? { connectors } : {}) });
  }

  // Private-service surface: exact method+path pairs only; HEAD mirrors GET for the same routes.
  for (const route of AGENTD_ROUTES) {
    const forward = (c: Context): Promise<Response> => forwardToAgentd(c, requestOwner(c), forwardDeps, connectsChannel(c) ? requestOwnerEmail(c) : undefined);
    // Deleting the account first revokes its hosted Spaces (BACKEND 5.12, option B): their pages and data sit on the hosting service,
    // which the private service cannot reach. A refusal leaves the account as it was, so the deletion can be asked again.
    const deleteAccount = async (c: Context): Promise<Response> => {
      const store = deps.store;
      if (store?.forOwner === undefined) throw new Error('Store.forOwner is required: refusing unscoped account deletion');
      const refused = await revokeOwnerHosted(store.forOwner(requestOwner(c)), deps.spaces?.hosted);
      return refused === undefined ? forward(c) : c.json({ error: { code: 'HOSTED_REVOKE_FAILED', message: refused } }, 503);
    };
    const handler = route.method === 'DELETE' && route.path === '/v1/account' ? deleteAccount : forward;
    app.on(route.method, route.path, handler);
    if (route.method === 'GET') app.on('HEAD', route.path, forward);
  }

  const serveWeb = deps.webDist ? createWebStaticHandler(deps.webDist) : null;
  app.notFound(async (c) => {
    const web = serveWeb ? await serveWeb(c.req.method, c.req.path) : null;
    return web ?? c.json({ error: { code: 'NOT_FOUND', message: 'No such route' } }, 404);
  });

  app.onError((error, c) => {
    if (error instanceof NotFoundError) {
      return c.json({ error: { code: 'NOT_FOUND', message: error.message } }, 404);
    }
    if (isClientAbort(error, c.req.raw.signal)) {
      // Expected when the client drops a stream (for example on logout); no stack, no error level.
      log.debug({ method: c.req.method, path: c.req.path }, 'API client disconnected');
      if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
    } else {
      log.error({ err: error }, 'API handler error');
    }
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } },
      500,
    );
  });

  return app;
}

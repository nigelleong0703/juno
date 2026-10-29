/**
 * Public API start-up: the account-mode gateway, as a function so the same code runs as a process (`main.ts`)
 * and in-process (`@agent-desktop/embedded`). Reads its settings from the given env; the caller owns the signals.
 *
 * Auth lives here, never in the private agentd: email/password sessions resolve the owner,
 * and every /v1 request is forwarded with the service bearer plus the authoritative owner.
 * Account mode is the default and the only mode: there is no token fallback, no default
 * users, and no plaintext password logging. The signed screen-stream bridge terminates here
 * and relays to computerd after checking the ticket.
 */
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { createBlobStore, createStore } from '@agent-desktop/db';
import { resolve } from 'node:path';
import { createApiApp } from './server.js';
import { createMediaCache, deriveMediaKey } from './media-proxy.js';
import { createSiteIconCache, deriveSiteIconKey } from './site-icon.js';
import type { ApiAuth } from './server.js';
import {
  accountAuthInfo,
  createAccountAuth,
  createAccountResolver,
  resolveAuthMode,
} from './account-auth.js';
import { parseApiConfig } from './config.js';
import { createAuthDbProbe, createDependencyReadiness } from './readiness.js';
import { createPostgresSettingsUpdater } from './modules/settings-postgres.js';
import { createStreamProxy } from './stream-proxy.js';
import { createSpaceOrigin } from './space-origin.js';
import { hostedSetup } from './modules/spaces-hosted.js';
import { checkEdgeHosts, hostKind } from './edge-hosts.js';
import { createArtifactOriginApp } from './artifact-origin.js';
import { createGatewayResolver } from './modules/spaces.js';
import { TRUSTED_APP_ORIGINS } from './account-auth.js';
import { createLogger } from '@agent-desktop/log';
import { requireSecretsKey } from '@agent-desktop/contracts/secrets';

const log = createLogger({ service: 'api' });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Cut every open connection at once (a stop that is taking too long). */
export function forceClose(server: unknown): void {
  if (!isRecord(server)) return;
  const closeAll = server['closeAllConnections'];
  if (typeof closeAll === 'function') closeAll();
}

/** The Postgres pool Better Auth keeps its sessions in. */
function createAuthPool(databaseUrl: string, max: number): Pool {
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, max });
  // Idle-client errors (e.g. Postmaster restarts) are emitted on the pool, not on a query:
  // without this listener they throw an unhandled 'error' event and crash the process.
  // The error value can carry the failed client with connection parameters, so log only
  // the normalized message/code, bounded, never the error object itself.
  pool.on('error', (error: unknown) => {
    const message = (error instanceof Error ? error.message : 'unknown').slice(0, 500);
    const rawCode = isRecord(error) ? error['code'] : undefined;
    const code = typeof rawCode === 'string' ? rawCode.slice(0, 100) : undefined;
    log.warn(
      { errMessage: message, ...(code === undefined ? {} : { errCode: code }) },
      'idle database connection failed',
    );
  });
  return pool;
}

export interface RunningApi {
  /** The port the gateway is listening on (on API_HOST). */
  port: number;
  server: ReturnType<typeof serve>;
  /** Stop accepting, let requests drain (bounded by 3 s, then the open connections are cut), then close the app store and the auth pool. */
  stop: () => Promise<void>;
  /** Close the app store and the auth pool now (the server is the caller's to stop). */
  closeDurableConnections: () => Promise<void>;
}

/** Start the public gateway with the settings in `env`. Throws when the settings are incomplete. */
export async function startApi(env: NodeJS.ProcessEnv = process.env): Promise<RunningApi> {
  const config = parseApiConfig(env);
  // E39/H-50: stored secrets are encrypted; refuse to boot without the key instead of failing on first write.
  requireSecretsKey();
  const authEnv = { ...env, AUTH_MODE: env.AUTH_MODE ?? 'account' };
  const authMode = resolveAuthMode(authEnv, config.DATABASE_URL);
  if (authMode.mode !== 'account') {
    throw new Error('The public API requires account auth; token mode is not served here');
  }
  log.info({ port: config.API_PORT, agentdUrl: config.AGENTD_URL }, 'Starting public API');

  // Durable owner-scoped store for the app-owned collections. Account mode guarantees a database URL,
  // so this never falls back to the in-memory store; a connection failure fails startup.
  const store = await createStore(authMode.databaseUrl, { poolMax: config.API_DB_POOL_MAX });
  // Better Auth keeps its sessions in the same database, on its own pool.
  const pool = createAuthPool(authMode.databaseUrl, config.API_DB_POOL_MAX);
  const instance = createAccountAuth({
    secret: authMode.secret,
    baseURL: authMode.baseURL,
    trustedOrigins: authMode.trustedOrigins,
    onUserCreated: async (ownerId, name) => {
      // The new account's default agent and first chat live in agentd; a failure must not fail sign-up.
      await fetch(config.AGENTD_URL.replace(/\/$/, '') + '/v1/onboarding/start', {
        method: 'POST', headers: { authorization: `Bearer ${config.INTERNAL_AGENTD_TOKEN}`, 'x-owner-id': ownerId, 'content-type': 'application/json' }, body: JSON.stringify({ name }), redirect: 'manual', signal: AbortSignal.timeout(10_000),
      }).then((response) => response.body?.cancel()).catch((error: unknown) => log.warn({ err: error }, 'onboarding start failed'));
    },
    database: pool,
  });
  const resolver = createAccountResolver(instance);
  const auth: ApiAuth = {
    info: accountAuthInfo(),
    handle: (request) => instance.handler(request),
    resolve: resolver.resolve,
  };

  const blobs = createBlobStore(env);
  // Postgres serialises settings read-modify-writes with an advisory lock.
  const settingsUpdater = createPostgresSettingsUpdater(pool);
  const closeDurableConnections = async (): Promise<void> => {
    await store.close();
    await pool.end();
  };

  // /healthz readiness: the gateway is ready only when the session pool, the app store (a
  // separate connection here), the private agentd answer. Each probe
  // is bounded and cancellable, so a hung database is really cancelled each poll instead of
  // accumulating; success is never cached, so a dependency that recovers is served again.
  const readiness = createDependencyReadiness({
    checkAuthDb: createAuthDbProbe(pool),
    checkAppStore: store.probe,
    agentdUrl: config.AGENTD_URL,
  });

  for (const warning of checkEdgeHosts({ apiOrigin: authMode.baseURL, artifactHost: config.ARTIFACT_HOST, spaceDomain: config.SPACE_DOMAIN })) log.warn({}, warning);
  const computerdLink = { url: config.COMPUTERD_URL, token: config.COMPUTERD_TOKEN };
  if (!config.COMPUTERD_TOKEN) log.warn({}, 'COMPUTERD_TOKEN is not set: Spaces cannot reach computers (status unknown, previews fail)');
  const spaceScheme = config.EDGE_SCHEME ?? new URL(authMode.baseURL).protocol.replace(':', '');
  const mediaKey = deriveMediaKey(config.ARTIFACT_URL_SECRET);
  // Hosted Spaces (BACKEND 5.12, option B): off until Cloudflare is configured; the publish routes then answer 503 with the reason.
  const hosted = hostedSetup(config, computerdLink);
  if (!hosted.ready) log.info({}, hosted.reason);
  const app = createApiApp({
    spaces: {
      domain: config.SPACE_DOMAIN,
      scheme: spaceScheme,
      secret: config.SPACE_URL_SECRET,
      computerd: computerdLink,
      hosted,
    },
    media: { key: mediaKey, cache: createMediaCache({ dir: resolve(config.MEDIA_CACHE_DIR) }), origin: authMode.baseURL, edgeScheme: config.EDGE_SCHEME },
    siteIcon: { key: deriveSiteIconKey(config.ARTIFACT_URL_SECRET), cache: createSiteIconCache({ dir: resolve(config.SITE_ICON_CACHE_DIR) }), origin: authMode.baseURL },
    artifactOrigin: { origin: `${spaceScheme}://${config.ARTIFACT_HOST}`, secret: config.ARTIFACT_URL_SECRET },
    edge: {
      artifactHost: config.ARTIFACT_HOST,
      spaceDomain: config.SPACE_DOMAIN,
      spaceExists: async (id) => (await store.get('spaces', id))?.status === 'published',
    },
    auth,
    agentdUrl: config.AGENTD_URL,
    internalToken: config.INTERNAL_AGENTD_TOKEN,
    adminToken: config.ADMIN_TOKEN,
    store,
    blobs,
    settingsUpdater,
    readiness,
    publicUrl: authMode.baseURL,
    // The platform default (MODEL_BASE_URL + MODEL_ID) is optional; it tells clients whether a run can start without an owner provider.
    platformDefault: Boolean(env.MODEL_BASE_URL) && Boolean(env.MODEL_ID),
    ...(env.WEB_DIST ? { webDist: env.WEB_DIST } : {}),
  });

  // Spaces: each app on its own subdomain of SPACE_DOMAIN, on this same port; the Host header picks the handler, and
  // the session cookie set there is the only credential (BACKEND 5.12).
  const spaceOrigin = createSpaceOrigin({
    store,
    secret: config.SPACE_URL_SECRET,
    domain: config.SPACE_DOMAIN,
    secure: spaceScheme === 'https',
    gateway: createGatewayResolver(computerdLink),
  });
  // HTML artifacts: no auth, no cookies; the signed URL is the only credential. Only ever reached by Host === ARTIFACT_HOST.
  const artifactPages = createArtifactOriginApp({
    store,
    blobs,
    secret: config.ARTIFACT_URL_SECRET,
    frameAncestors: [...new Set([new URL(authMode.baseURL).origin, ...TRUSTED_APP_ORIGINS, ...authMode.trustedOrigins])],
  });
  const hosts = { artifactHost: config.ARTIFACT_HOST, spaceDomain: config.SPACE_DOMAIN };
  // One port, three kinds of host. The untrusted ones never reach the API app (no session, CORS or cookie handling of ours).
  const handlers = { artifact: artifactPages, space: spaceOrigin.app, api: app };
  let boundPort = config.API_PORT;
  const server = await new Promise<ReturnType<typeof serve>>((resolveServer) => {
    const created = serve(
      {
        fetch: (request, fetchEnv) => handlers[hostKind(request.headers.get('host') ?? undefined, hosts)].fetch(request, fetchEnv),
        port: config.API_PORT,
        hostname: config.API_HOST,
      },
      (info) => {
        boundPort = info.port;
        log.info({ address: info.address, port: info.port, artifactHost: config.ARTIFACT_HOST, spaceDomain: config.SPACE_DOMAIN }, 'Listening');
        resolveServer(created);
      },
    );
  });

  const proxy = createStreamProxy({
    computerdUrl: config.COMPUTERD_URL,
    ticketSecret: config.SCREEN_TICKET_SECRET,
    log: (fields, message) => log.info(fields, message),
    // Presence: agentd tells the agent the user is watching its screen. Best effort; a lost notice
    // only means the agent does not know it is watched.
    onWatch: ({ ownerId, agentId }, watching) => {
      void fetch(new URL('/v1/presence/screen', config.AGENTD_URL), {
        method: 'POST',
        headers: { authorization: `Bearer ${config.INTERNAL_AGENTD_TOKEN}`, 'x-owner-id': ownerId, 'content-type': 'application/json' },
        body: JSON.stringify({ agentId, watching }),
      }).catch((error: unknown) => log.warn({ err: error, agentId }, 'presence notice failed'));
    },
  });
  server.on('upgrade', (request, socket, head) => (hostKind(request.headers.host, hosts) === 'space' ? spaceOrigin.handleUpgrade(request, socket, head) : proxy.handleUpgrade(request, socket, head)));

  const stop = async (): Promise<void> => {
    // Requests in flight get 3 s to finish; after that their connections are cut so the stop completes.
    const drain = setTimeout(() => forceClose(server), 3000);
    drain.unref();
    await new Promise<void>((done) => server.close(() => done()));
    clearTimeout(drain);
    await closeDurableConnections();
  };
  return { port: boundPort, server, stop, closeDurableConnections };
}

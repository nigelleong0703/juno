/**
 * Internal agent API: loopback-only Hono app for service-to-service calls (packages/api -> agentd).
 *
 * Same /v1 contract as the public API (including SSE) so MG1 can forward unchanged, but
 * every request must carry the service bearer token AND a non-empty x-owner-id header.
 * There is no token-mode owner fallback and no session/login fallback in live mode:
 * missing or wrong credentials are 401, never a default owner. Account endpoints stay 404.
 */

import type { FeishuRegisterApp } from '../../routes/index.js';
import type { PluginRoute } from '../../plugins/host.js';
import type { ChannelRegistry } from '../../channels/registry.js';
import type { StoredCatalog } from 'juno-agent/modules/apps/catalog';
import { registerAdminApps } from '../../apps/admin.js';
import { createMcpManager, guardedFetch, type McpManager } from 'juno-agent/modules/mcp/index';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { BlobStore, Enqueuer, EventBus, Store } from '@agent-desktop/contracts';
import { NotFoundError } from '@agent-desktop/contracts';
import type { BackendConfig } from 'juno-agent';
import { bearerAuth } from '../../auth.js';
import type { AuthOptions, AuthResolver } from '../../auth.js';
import type { Identity } from '@agent-desktop/memory-graph/identity';
import type { MemoryPort } from 'juno-agent/modules/memory/port';
import type { SkillsService } from '@agent-desktop/memory-graph/skills';
import type { AccountEraser } from '../../account/erase.js';
import type { EvolutionControl } from '../../evaluation/skill-evolution.js';
import type { ComputerdClient } from '../../computerd.js';
import { aguiSnapshots, eventCursor, streamEvents } from '../../events.js';
import { clientKind, connectClient, watchScreen } from 'juno-agent/execution/presence';
import {
  ownerBus,
  ownerStore,
  requestOwnerId,
  requestScopedBus,
  requestScopedStore,
  requireAccountStores,
  runWithOwner,
} from '../../owner-scope.js';
import { registerRoutes } from '../../routes/index.js';
import type { Speaker } from '../../routes/speech.js';

const RUN_NOW_SERVICES: ReadonlySet<string> = new Set(['MemoryTimer', 'IdeasTimer', 'ChatDigest', 'Session']);

export interface InternalAgentDeps {
  store: Store;
  bus: EventBus;
  enqueuer: Enqueuer;
  config?: BackendConfig;
  /** computerd's internal API; absent keeps the screen routes out of the app. */
  computerd?: ComputerdClient;
  /** Runs a timer's `runNow` job and waits for its answer (operators and the e2e suite); absent keeps the route out of the app. */
  runNow?: (service: string, key: string, input: unknown) => Promise<unknown>;
  /** Deletes a whole account (`DELETE /v1/account`); absent keeps the route out of the app. */
  accountEraser?: AccountEraser;
  /** The identity graph; absent when there is no Postgres, and speakers are then not recorded. */
  identity?: Identity;
  /** Memory (Postgres); absent without it. */
  memory?: MemoryPort;
  /** The versioned skill store (Postgres); absent without it, and the skill routes answer 503. */
  skills?: SkillsService;
  /** Platform skill evolution (BACKEND §5.15): the admin read and the run-now; absent without Postgres, and the routes are then not there. */
  evolution?: EvolutionControl;
  /** The chat platforms the loaded plugins registered. */
  channels: ChannelRegistry;
  /** The blob store: platform files a chat message carries are kept there (through the library). */
  blobs?: BlobStore;
  /** The app catalog table; the gateway (packages/api) reads the offered connectors from `GET /internal/connector-catalog`, and the admin routes edit it. Absent keeps both out of the app. */
  appCatalog?: StoredCatalog;
  /** Lists an app's tools for its capability list on the Apps page; absent builds one over the catalog (outbound calls through the private-network guard). */
  mcp?: McpManager;
  /** Fetch for the Telegram Bot API; absent uses the global fetch (tests inject a fake). */
  channelFetch?: typeof fetch;
  /** Feishu `registerApp`; absent uses the SDK's (tests inject a fake). */
  feishuRegisterApp?: FeishuRegisterApp;
  /** Text-to-speech sidecar client; absent uses the one TTS_ENABLED configures (tests inject a fake). */
  speaker?: Speaker;
  /** The HTTP routes the loaded plugins registered; boot passes the host's list. */
  pluginRoutes?: readonly PluginRoute[];
  /** Service bearer token; required and non-empty, read from INTERNAL_AGENTD_TOKEN. */
  internalToken: string;
}

/**
 * Service identity for one request: exact bearer match plus a non-empty owner header.
 * The resolver returns null (401) for every other shape; it never derives an owner.
 */
function serviceResolver(internalToken: string): AuthResolver {
  return {
    mode: 'account',
    providers: [],
    resolve: async (req) => {
      if (req.headers.get('authorization') !== `Bearer ${internalToken}`) return null;
      const ownerId = req.headers.get('x-owner-id');
      if (!ownerId) return null;
      const email = req.headers.get('x-owner-email');
      return email ? { ownerId, email } : { ownerId };
    },
  };
}

export function createInternalAgentApp(deps: InternalAgentDeps): Hono {
  if (!deps.internalToken) {
    throw new Error('createInternalAgentApp requires a non-empty internalToken');
  }
  // Owner-scoped stores are mandatory: without forOwner the request scope cannot hold.
  requireAccountStores({ store: deps.store, bus: deps.bus });

  const auth: AuthOptions = {
    resolver: serviceResolver(deps.internalToken),
    runAsOwner: (ownerId, next) => runWithOwner(ownerId, next),
  };

  const app = new Hono();

  app.get('/healthz', (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // The connector catalog is deployment-wide, not per owner: the service bearer alone opens it.
  const catalog = deps.appCatalog;
  const mcp = deps.mcp ?? (catalog === undefined ? undefined : createMcpManager({ catalog, fetchImpl: guardedFetch }));
  if (catalog !== undefined) {
    // `items` are the apps offered to add; `held` also carries the hidden ones, which owners who added them keep using (removing one still revokes its tokens).
    app.get('/internal/connector-catalog', (c) => c.req.header('authorization') === `Bearer ${deps.internalToken}`
      ? c.json({ items: catalog.list(), held: [...catalog.list(), ...catalog.hidden()] })
      : c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' } }, 401));
    registerAdminApps(app, { catalog, chatPlugins: () => deps.channels.all().map((registration) => registration.kind), internalToken: deps.internalToken, fetchImpl: guardedFetch, env: process.env });
  }

  // Platform skill evolution is deployment-wide too: the service bearer alone opens it (an operator's read, never an agent's). Aggregates only.
  const evolution = deps.evolution;
  if (evolution !== undefined) {
    const authorized = (c: Context): boolean => c.req.header('authorization') === `Bearer ${deps.internalToken}`;
    const refuse = (c: Context) => c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' } }, 401);
    app.get('/internal/skill-evolution', async (c) => (authorized(c) ? c.json(await evolution.report()) : refuse(c)));
    app.post('/internal/skill-evolution/run', async (c) => {
      if (!authorized(c)) return refuse(c);
      const body: unknown = await c.req.json().catch(() => undefined);
      const raw = typeof body === 'object' && body !== null ? Reflect.get(body, 'at') : undefined;
      const at = typeof raw === 'string' && Number.isFinite(Date.parse(raw)) ? new Date(raw) : undefined;
      return c.json(await evolution.runNow(at));
    });
  }

  // No login/session surface on the internal service: every account endpoint stays 404.
  const authDisabled = (c: Context) => {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Account authentication is disabled' } }, 404);
  };
  app.get('/auth/info', authDisabled);
  app.all('/auth/*', authDisabled);

  // SSE shares the service auth; a request without token and owner never reaches the stream.
  app.use('/v1/events', bearerAuth(auth));
  app.get('/v1/events', async (c) => {
    const ownerId = requestOwnerId(c);
    // An app that names itself (x-juno-client) counts as "the user has it open" while its stream lives; the row workers read is written before the stream starts.
    const client = clientKind(c.req.header('x-juno-client'));
    const leave = client === undefined ? undefined : await connectClient(ownerStore(deps, ownerId), ownerId, client);
    return streamEvents(c, ownerBus({ bus: deps.bus }, ownerId), leave === undefined ? undefined : () => { leave().catch(() => undefined); }, aguiSnapshots(ownerStore(deps, ownerId)), ownerId);
  });
  // The gateway reports a screen stream opening or closing, so the agent knows it is being watched.
  app.use('/v1/presence/screen', bearerAuth(auth));
  app.post('/v1/presence/screen', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const agentId = typeof body === 'object' && body !== null ? Reflect.get(body, 'agentId') : undefined;
    const watching = typeof body === 'object' && body !== null ? Reflect.get(body, 'watching') : undefined;
    if (typeof agentId !== 'string' || agentId.length === 0 || typeof watching !== 'boolean') {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'agentId and watching are required' } }, 400);
    }
    const ownerId = requestOwnerId(c);
    await watchScreen(ownerStore(deps, ownerId), ownerId, agentId, watching);
    return c.body(null, 204);
  });
  // Operators and the e2e suite run a timer's job now instead of waiting for its schedule.
  const runNow = deps.runNow;
  if (runNow !== undefined) {
    app.use('/v1/internal/run-now/*', bearerAuth(auth));
    app.post('/v1/internal/run-now/:service/:key', async (c) => {
      const service = c.req.param('service');
      if (!RUN_NOW_SERVICES.has(service)) return c.json({ error: { code: 'NOT_FOUND', message: 'No such timer' } }, 404);
      const input: unknown = await c.req.json().catch(() => undefined);
      return c.json(await runNow(service, c.req.param('key'), input));
    });
  }
  app.use('/v1/events/cursor', bearerAuth(auth));
  app.get('/v1/events/cursor', async (c) => {
    return c.json({ after: await eventCursor(ownerBus({ bus: deps.bus }, requestOwnerId(c))) });
  });

  app.onError((error, c) => {
    if (error instanceof NotFoundError) {
      return c.json({ error: { code: 'NOT_FOUND', message: error.message } }, 404);
    }
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } },
      500,
    );
  });

  registerRoutes(app, {
    store: requestScopedStore(deps.store),
    bus: requestScopedBus(deps.bus),
    enqueuer: deps.enqueuer,
    config: deps.config,
    channels: deps.channels,
    ...(catalog === undefined ? {} : { appCatalog: catalog }),
    ...(mcp === undefined ? {} : { mcp }),
    ...(deps.blobs ? { blobs: deps.blobs } : {}),
    ...(deps.computerd ? { computerd: deps.computerd } : {}),
    ...(deps.accountEraser ? { accountEraser: deps.accountEraser } : {}),
    ...(deps.channelFetch ? { channelFetch: deps.channelFetch } : {}),
    ...(deps.identity ? { identity: deps.identity } : {}),
    ...(deps.memory ? { memory: deps.memory } : {}),
    ...(deps.skills ? { skills: deps.skills } : {}),
    ...(deps.feishuRegisterApp ? { feishuRegisterApp: deps.feishuRegisterApp } : {}),
    ...(deps.speaker ? { speaker: deps.speaker } : {}),
    ...(deps.pluginRoutes ? { pluginRoutes: deps.pluginRoutes } : {}),
    auth,
  });

  return app;
}

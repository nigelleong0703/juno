/**
 * agentd start-up: the private internal HTTP API and the durable runner that executes the
 * Session/Run/timer services.
 *
 * The loopback-only /v1 service serves packages/api (service bearer plus server-resolved owner); the
 * runner executes the Session/Run/RoutineTimer services in the same assembly the HTTP process uses.
 * Auth, accounts and the public screen WebSocket live in packages/api, never here. `main.ts` runs this as
 * a process.
 *
 * Roles (`AGENTD_ROLE`, or `AgentdOptions.role`):
 *   all          coordinator + execution in one process; keeps the historical default and the instance lock
 *   coordinator  platform singletons and HTTP only; stores durable work for workers and executes none
 *   worker       execution only, with the same store/plugins/tools as the coordinator but no HTTP, no
 *                singleton effects, no instance lock and no boot maintenance
 *
 * Mixed versions: only the holder of the whole-process advisory lock may reclaim rows written before worker
 * leases existed, and it publishes the `worker-leases` capability marker those workers require. See
 * execution/coordination.ts for the rollback boundary.
 */

import { serve } from '@hono/node-server';
import { forgetPresence, startPresenceHeartbeat } from 'juno-agent/execution/presence';
import { createRemoteVoicePort, serveVoiceCalls } from 'juno-agent/modules/tools/tools/discordVoiceRemote';
import {
  acquireInstanceLock, assertConnectionBudget, createBlobStore, createStore,
  COORDINATOR_EXTRA_CONNECTIONS, DEFAULT_API_POOL, DEFAULT_COORDINATOR_POOL, DEFAULT_MEMORYD_POOL, DEFAULT_WORKER_POOL, WORKER_EXTRA_CONNECTIONS,
  type DbStore,
} from '@agent-desktop/db';
import { createLogger } from '@agent-desktop/log';
import { requireSecretsKey } from '@agent-desktop/contracts/secrets';
import { getConfig } from './config.js';
import { createInternalAgentApp } from './transport/http/internal-app.js';
import { RunnerEnqueuer, NoopEnqueuer } from './enqueuer.js';
import { createRunner, type Runner } from '@agent-desktop/durable';
import { requireOwnerId } from './owner-scope.js';
import { createComputerdClient } from './computerd.js';
import { createAccountEraser } from './account/erase.js';
import { createEmbedder } from 'juno-agent/modules/memory/embedder';
import { createMemoryModule } from 'juno-agent/modules/memory/assembly';
import { createRemoteMemoryPort } from '@agent-desktop/memoryd/client';
import { createPlatformSkillsService, createSkillsService, platformSkillsDir, seedPlatformSkills } from '@agent-desktop/memory-graph/skills';
import { harnessSeedVersion } from 'juno-agent/modules/harness/loader';
import { bootHarnessVersions } from 'juno-agent/modules/harness/store';
import { createPostgresHarnessStore } from './harness/versions.js';
import { runMigrations } from './migrations/runner.js';
import { migrations } from './migrations/registry.js';
import { createExecutionComputer, startExecution } from './execution/start.js';
import { armMissingTimers } from './execution/arm-timers.js';
import { requireWorkerLeaseCoordination, startWorkerLeaseCoordination, type WorkerLeaseCoordination } from './execution/coordination.js';
import { createPluginHost, type PluginHost } from './plugins/host.js';
import { pluginRowsFromEnv } from './plugins/config.js';
import { builtinPlugins } from './plugins/builtin.js';
import type { Services } from './plugins/services.js';
import { startPushNotifications } from './push/notifier.js';
import { startChannelDelivery } from './channels/delivery.js';
import { startControlNotices } from './routes/control-notices.js';
import { channelRegistryOf, type ChannelRegistry } from './channels/registry.js';
import { startChannelRunners } from './channels/runners.js';
import { createStoredCatalog, type StoredCatalog } from 'juno-agent/modules/apps/catalog';
import type { ConnectorCatalog } from 'juno-agent/modules/mcp/catalog';
import type { MemoryPort } from 'juno-agent/modules/memory/port';
import { appSkillGate, syncAppSkills } from './apps/skills.js';
import { seedRows, webSeedRows } from './apps/seed.js';
import { startWeeklyEvaluation } from './evaluation/weekly.js';
import { rawThumbnailCandidates, startThumbnailBackfill } from './artifacts/thumbnails.js';
import { createEvolutionControl, startSkillEvolution } from './evaluation/skill-evolution.js';
import { createChatComplete, readPlatformModelEnv } from './evaluation/platform-model.js';

const log = createLogger({ service: 'agentd' });

/** How long durable events are kept for replay; a client further behind gets `event: reset` (BACKEND §10.3). */
const EVENT_RETENTION_DAYS = 7;
const EVENT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** How often this process re-reads the app catalog table, so an edit made through another process (or a restart-free admin write) reaches it. */
const CATALOG_REFRESH_MS = 10_000;

/** Postgres when DATABASE_URL is set, otherwise the in-memory store for tests and offline dev. */
async function openStore(config: ReturnType<typeof getConfig>, coordinator: boolean) {
  const databaseUrl = config.DATABASE_URL;
  if (!databaseUrl) log.info('Using memory store (set DATABASE_URL for Postgres)');
  else log.info('Using durable store');
  const coordinatorPool = config.AGENTD_DB_POOL_MAX ?? DEFAULT_COORDINATOR_POOL;
  const workerPool = config.AGENTD_WORKER_DB_POOL_MAX ?? DEFAULT_WORKER_POOL;
  const poolMax = coordinator ? coordinatorPool : workerPool;
  // Two lease lifetimes: a transaction left open that long belongs to a frozen process, whose lease check would block every takeover (BACKEND 2.2c).
  const store = await createStore(databaseUrl, { poolMax, idleInTransactionMs: 2 * config.AGENTD_LEASE_TTL_MS });
  if (store.raw === undefined) return store;
  // Fail now, with the arithmetic, instead of at the first burst of work (BACKEND 2.2c). The lock connection is already open and counted in use.
  try {
    const checked = await assertConnectionBudget(
      store.raw,
      { coordinatorPool, workers: config.AGENTD_EXPECTED_WORKERS, workerPool, apiPool: 2 * (config.API_DB_POOL_MAX ?? DEFAULT_API_POOL), memorydPool: config.MEMORYD_DB_POOL_MAX ?? DEFAULT_MEMORYD_POOL },
      { pool: poolMax, extra: coordinator ? COORDINATOR_EXTRA_CONNECTIONS - 1 : WORKER_EXTRA_CONNECTIONS },
    );
    log.info({ poolMax, planned: checked.total, maxConnections: checked.maxConnections, reserved: checked.reserved, inUse: checked.inUse }, 'Postgres connection budget fits');
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }
  return store;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Node exposes closeIdleConnections/closeAllConnections on HTTP/1 servers but not on the HTTP/2
 * variants, so touch them only when the running server actually has them.
 */
export function closeServerConnections(server: unknown, mode: 'idle' | 'all'): void {
  if (!isRecord(server)) return;
  const method = mode === 'idle' ? server['closeIdleConnections'] : server['closeAllConnections'];
  if (typeof method === 'function') method.call(server);
}

export type AgentdRole = 'all' | 'coordinator' | 'worker';

export interface AgentdOptions {
  /** An already open store, shared with other services of the same process; absent opens DATABASE_URL and closes it on stop. */
  store?: DbStore;
  /** Listen port on 127.0.0.1; 0 picks a free one. Absent: AGENTD_PORT. A worker serves no HTTP API. */
  port?: number;
  /** What this process runs. Absent: AGENTD_ROLE (`all`). */
  role?: AgentdRole;
}

export interface RunningAgentd {
  port: number;
  /** The internal HTTP server; undefined on an execution-only worker. */
  server: unknown;
  /** Which role this process took, for logs and acceptance checks. */
  role: AgentdRole;
  /** Stop accepting, drop connections, stop the runner, (when it opened it) close the store, then release the instance lock. */
  stop: () => Promise<void>;
}

export async function startAgentd(options: AgentdOptions = {}): Promise<RunningAgentd> {
  const config = getConfig();
  const role: AgentdRole = options.role ?? config.AGENTD_ROLE;
  // E39: no built-in secrets. agentd always wires computerd (COMPUTERD_URL has a default),
  // signs screen tickets and calls it with these, so both are required at boot.
  for (const name of ['COMPUTERD_TOKEN', 'SCREEN_TICKET_SECRET'] as const) {
    if (!config[name]) throw new Error(name + ' is required: agentd has no built-in default');
  }
  if (config.MEMORYD_URL !== '' && config.MEMORYD_TOKEN === '') throw new Error('MEMORYD_TOKEN is required when MEMORYD_URL is set: agentd has no built-in default');
  // H-50: stored MCP credentials are encrypted; refuse to boot without the key instead of failing on first use.
  requireSecretsKey();
  if (role !== 'worker' && !config.INTERNAL_AGENTD_TOKEN) {
    throw new Error('INTERNAL_AGENTD_TOKEN is required: the private agentd only serves the service bearer');
  }

  if (role === 'worker') {
    log.info({ role }, 'Starting execution worker');
    return bootExecutionWorker(options, config);
  }

  const listenPort = options.port ?? config.AGENTD_PORT;
  log.info({ port: listenPort, role }, 'Starting internal agentd');

  // One coordinator per database: the gateways, pollers, push and prune jobs are process-wide singletons, and the
  // coordinator is the only process allowed to reclaim pre-lease rows. Nothing below starts until the lock is ours
  // (a second coordinator waits here, its HTTP port unbound, so it never looks ready). Execution workers do not take
  // this lock: they claim through the database instead.
  const lock = await acquireInstanceLock(config.DATABASE_URL, {
    onLost: (reason) => {
      log.error({ reason }, 'Lost the agentd instance lock; exiting so the supervisor restarts it');
      process.exit(1);
    },
  });
  try {
    const running = await bootCoordinator(options, config, listenPort, role);
    return { ...running, stop: () => running.stop().finally(() => lock.release()) };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

/** Everything both roles share: store, memory, skills, plugins, tools, catalog and the durable runner. */
interface Core {
  store: DbStore;
  ownsStore: boolean;
  blobs: ReturnType<typeof createBlobStore>;
  bus: DbStore['eventBus'];
  raw: DbStore['raw'];
  skills: ReturnType<typeof createSkillsService> | undefined;
  platformSkills: ReturnType<typeof createPlatformSkillsService> | undefined;
  harnessVersions: ReturnType<typeof createPostgresHarnessStore> | undefined;
  computerd: ReturnType<typeof createComputerdClient>;
  memory: ReturnType<typeof createMemoryModule> | undefined;
  memoryPort: MemoryPort | undefined;
  computer: ReturnType<typeof createExecutionComputer>;
  plugins: PluginHost<Services>;
  channels: ChannelRegistry;
  catalog: StoredCatalog;
  voice: ReturnType<ChannelRegistry['voice']>;
  monitorChecks: boolean;
  runner: Runner | undefined;
  enqueuer: RunnerEnqueuer | NoopEnqueuer;
  stopCatalogWatch: () => void;
  close: () => Promise<void>;
}

async function buildCore(options: AgentdOptions, config: ReturnType<typeof getConfig>, mode: { coordinator: boolean; executes: boolean; capabilityCheck?: () => Promise<void> }): Promise<Core> {
  const store = options.store ?? await openStore(config, mode.coordinator);
  const ownsStore = options.store === undefined;
  const blobs = createBlobStore(process.env);
  const bus = store.eventBus;
  // The identity graph and the rest of memory are raw SQL, so only a Postgres store has them; with the in-memory store speakers are not recorded.
  const raw = store.raw;
  // Versioned skills are raw SQL too (migration 0049): with the in-memory store there is no skill store, and no skill can be selected.
  const skills = raw === undefined ? undefined : createSkillsService(raw);
  // The platform skills are versioned rows too (migration 0051), seeded from the image's SKILL.md files; an unreadable folder or a failed seed
  // only means skill_read falls back to the computer's files.
  // The skills an app package ships are rows of the same store (source `app:<appId>`); an agent reads one only while the owner has the app
  // added and turned on for it. The gate reads the app catalog, which is built later in this function, so it is bound there.
  const appCatalogForSkills: { current?: ConnectorCatalog } = {};
  const platformSkills = raw === undefined ? undefined : createPlatformSkillsService(raw, { gate: appSkillGate({ store: () => store, catalog: () => appCatalogForSkills.current }) });
  if (platformSkills !== undefined && mode.coordinator) {
    await seedPlatformSkills(platformSkills)
      .then((seeded) => log.info({ created: seeded.created.length, updated: seeded.updated.length, unchanged: seeded.unchanged.length }, 'Platform skills seeded'))
      .catch((error: unknown) => log.error({ err: error }, 'Platform skills could not be seeded; skill_read reads the computer\'s files'));
  }
  // The harness package (BACKEND §11.2): the repository seed becomes the active version of its store (migration 0053). An invalid seed
  // throws here, so the process does not start; without a database the seed is validated and served directly. Only the
  // coordinator writes the seed: workers read the versions it published.
  const harnessVersions = raw === undefined ? undefined : createPostgresHarnessStore(raw);
  if (harnessVersions === undefined) harnessSeedVersion();
  else if (mode.coordinator) await bootHarnessVersions(harnessVersions);
  // The computer's home is where the memory views are written, so the client is made before the memory module (it holds no state of its own).
  const computerd = createComputerdClient({
    baseUrl: config.COMPUTERD_URL,
    token: config.COMPUTERD_TOKEN,
    fetch: (input, init) => fetch(input, init),
    // Server-resolved owner only: the authenticated request's ALS scope. A missing owner throws
    // instead of falling back to the legacy single-user id, so a mis-wired call fails closed.
    getOwnerId: () => requireOwnerId(),
  });
  // EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL: a hosted embeddings API; without them memory is searched by words only.
  const embedder = createEmbedder(process.env, { log: (fields, message) => log.warn(fields, message) });
  // The memory items are the source of truth (BACKEND §5.4): the memory module exists only with Postgres. An item is embedded soon after
  // it is written (the module's writer); its start-up backfill embeds the rest.
  const memory = createMemoryModule({ store, ...(raw === undefined ? {} : { raw }), ...(embedder === undefined ? {} : { embedder }), home: computerd.home, log });
  if (mode.coordinator) {
    // The one-time data moves, in order, each with its marker row (migrations/registry.ts). A failure is logged, and the entry says what it stops.
    await runMigrations(migrations, { store, ...(raw === undefined ? {} : { raw }), ...(memory === undefined ? {} : { identity: memory.graph.identity, memory: memory.graph }) }, log);
    memory?.start();
  }
  // memoryd (BACKEND §2.4): with MEMORYD_URL the runtime reads and writes memory through that service. This process keeps the graph
  // either way (the migrations, the nightly jobs and channel ingress use it until B2 moves them).
  const memoryPort = memory === undefined ? undefined : config.MEMORYD_URL === ''
    ? memory.port
    : createRemoteMemoryPort({ url: config.MEMORYD_URL, token: config.MEMORYD_TOKEN, graph: memory.graph, log: (fields, message) => log.warn(fields, message) });
  // The durable runner: a coordinator only stores and waits; a worker claims. Retention pruning belongs to one process.
  // Only an execution worker is bounded (default 8, to share bursts with the other workers); a process that runs everything
  // (`AGENTD_ROLE=all`) is not, since one bound there would cap every owner together.
  const workerOnly = mode.executes && !mode.coordinator;
  const maxConcurrent = config.AGENTD_WORKER_CONCURRENCY ?? (workerOnly ? 8 : undefined);
  const runner = raw === undefined ? undefined : createRunner({
    db: raw,
    execute: mode.executes,
    prune: mode.coordinator,
    ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
    leaseTtlMs: config.AGENTD_LEASE_TTL_MS,
    ...(config.AGENTD_WORKER_ID === '' ? {} : { workerId: config.AGENTD_WORKER_ID }),
    ...(mode.capabilityCheck === undefined ? {} : { capabilityCheck: mode.capabilityCheck }),
    log: (fields, message) => log.info(fields, message),
  });
  const enqueuer = runner === undefined ? new NoopEnqueuer(store) : new RunnerEnqueuer(runner, store);
  // Plugins (docs/BACKEND.md "Plugins") load once the core services exist and before the runners, the HTTP server and the
  // execution service start. Their statuses are logged here; the tools they added are handed to execution below. An
  // execution-only worker skips process singletons (watchers, pollers): the coordinator already runs exactly one.
  const computer = runner === undefined ? undefined : createExecutionComputer({ store, config, computerd });
  const plugins = createPluginHost<Services>({ log, rows: pluginRowsFromEnv(process.env), singletons: mode.coordinator });
  plugins.provide('store', store);
  plugins.provide('enqueuer', enqueuer);
  plugins.provide('computerd', computerd);
  plugins.provide('computer', computer);
  for (const plugin of builtinPlugins) plugins.use(plugin);
  await plugins.load();
  // The chat platforms are whatever the platform plugins registered; nothing else knows a platform. Replies in channel
  // conversations go back through them, and their runners (Telegram long-poll, gateways) admit inbound events.
  const channels = channelRegistryOf(plugins);
  // The app catalog is a table (BACKEND 10.18). What the loaded plugins registered, and the chat platforms running here, only seed rows
  // the table does not have yet; after that the table says what the Apps page lists and what agents can use. The agent reads it directly,
  // the gateway (api process) reads it from here, and it reloads on a timer so an admin edit made through another process shows up.
  const connectorCatalog = await createStoredCatalog({
    store,
    seed: mode.coordinator ? seedRows(
      plugins.connectors(),
      channels.all().map((registration) => registration.kind),
      new Date(),
      // The Web & video apps ship their skill from the image's source files; without the folder they are added at a later boot that has it.
      await webSeedRows(platformSkillsDir()).catch((error: unknown) => { log.error({ err: error }, 'The Web & video apps could not be seeded'); return []; }),
    ) : [],
    // A package written through the admin API seeds its skills into the platform store before the write is answered.
    afterWrite: async (row) => { if (platformSkills !== undefined) await syncAppSkills(platformSkills, [row]); },
  });
  appCatalogForSkills.current = connectorCatalog;
  // Every package's skills are in the store from the first start (a pack that came with a plugin, or was written by another process).
  if (platformSkills !== undefined && mode.coordinator) {
    await syncAppSkills(platformSkills, connectorCatalog.rows())
      .catch((error: unknown) => log.error({ err: error }, 'App skill packs could not be seeded; their skills are not available'));
  }
  // Read-cache refresh runs in every process: a long-lived worker must see catalog and admin capability edits.
  // It is not an exclusive external effect (no gateway, poller or push), so it is not a coordinator singleton.
  // Permission revocation still happens at effect time: the tool call re-reads the current rows before acting.
  const stopCatalogWatch = connectorCatalog.watch(CATALOG_REFRESH_MS);
  return {
    store, ownsStore, blobs, bus, raw, skills, platformSkills, harnessVersions, computerd, memory, memoryPort, computer, plugins, channels,
    catalog: connectorCatalog,
    // The platform's voice sessions (Discord), when a platform plugin offers them; the voice tools read this one holder.
    // A worker has no gateway: its voice tools ask the coordinator that holds it through the database (BACKEND 2.2c).
    voice: mode.coordinator || channels.voice() === undefined ? channels.voice() : createRemoteVoicePort(store),
    // Monitors run while their plugin is active; a disabled plugin pauses them (their routines stay).
    monitorChecks: plugins.status().some((status) => status.name === 'monitors' && status.state === 'active'),
    runner, enqueuer,
    stopCatalogWatch,
    close: async () => {
      stopCatalogWatch();
      memory?.stop();
      runner?.stop();
      await plugins.stop();
      if (ownsStore) await store.close();
    },
  };
}

async function startExecutionOf(core: Core, config: ReturnType<typeof getConfig>): Promise<{ stop: () => Promise<void> }> {
  const { runner, enqueuer } = core;
  if (runner === undefined) return { stop: async () => undefined };
  return startExecution({
    store: core.store, blobs: core.blobs, config, runner, enqueuer,
    ...(core.voice === undefined ? {} : { voice: core.voice }),
    channels: core.channels,
    connectorCatalog: core.catalog,
    monitorChecks: core.monitorChecks,
    ...(core.memoryPort === undefined ? {} : { memory: core.memoryPort }),
    ...(core.skills === undefined ? {} : { skills: core.skills }),
    ...(core.platformSkills === undefined ? {} : { platformSkills: core.platformSkills }),
    ...(core.harnessVersions === undefined ? {} : { harnessVersions: core.harnessVersions }),
    pluginTools: core.plugins.tools(),
    promptSections: core.plugins.promptSections().map((section) => section.text),
    ...(core.computer === undefined ? {} : { computer: core.computer }),
  });
}

/** Execution-only process: same assembly as the coordinator, no HTTP and no platform singletons. */
async function bootExecutionWorker(options: AgentdOptions, config: ReturnType<typeof getConfig>): Promise<RunningAgentd> {
  const core = await buildCore(options, config, {
    coordinator: false,
    executes: true,
    capabilityCheck: async () => {
      const raw = core.raw;
      if (raw === undefined) throw new Error('the execution worker has no Postgres connection for the coordinator gate');
      await requireWorkerLeaseCoordination(raw);
    },
  });
  if (core.raw === undefined) {
    await core.close();
    throw new Error('refusing to start an execution worker without Postgres: worker leases need a shared database');
  }
  await requireWorkerLeaseCoordination(core.raw);
  const execution = await startExecutionOf(core, config).catch(async (error: unknown) => {
    log.error({ err: error }, 'Execution failed to start');
    await core.close();
    throw error;
  });
  log.info({ worker: core.runner?.identity }, 'Execution worker running');
  return {
    port: 0,
    server: undefined,
    role: 'worker',
    stop: async () => { await Promise.allSettled([execution.stop(), core.close()]); },
  };
}

async function bootCoordinator(options: AgentdOptions, config: ReturnType<typeof getConfig>, listenPort: number, role: AgentdRole): Promise<RunningAgentd> {
  const core = await buildCore(options, config, { coordinator: true, executes: role === 'all' });
  const { store, bus, raw, skills, platformSkills, computerd, memory, memoryPort, computer, plugins, channels, catalog, runner } = core;
  // Only the lock holder may hand over pre-lease rows and publish the capability marker workers require.
  let coordination: WorkerLeaseCoordination | undefined;
  try {
    coordination = raw === undefined ? undefined : await startWorkerLeaseCoordination(raw);
    const pruneEvents = (): void => {
      bus.prune(new Date(Date.now() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000))
        .then((count) => { if (count > 0) log.info({ count }, 'Pruned old events'); })
        .catch((error) => log.error({ err: error }, 'Event pruning failed'));
    };
    pruneEvents();
    const pruneTimer = setInterval(pruneEvents, EVENT_PRUNE_INTERVAL_MS);
    pruneTimer.unref();
    // Workers read the open apps, the iPhone's declaration and the Discord voice service from the database (BACKEND 2.2c): this process holds them.
    await forgetPresence(store);
    const stopPresence = startPresenceHeartbeat(store);
    const stopVoiceCalls = core.voice === undefined || role === 'all' ? () => undefined : serveVoiceCalls(store, core.voice);
    // The weekly tool x model report (BACKEND §11.1): an operator job over all owners' steps; it needs Postgres.
    const stopWeekly = raw === undefined ? () => undefined : startWeeklyEvaluation({ db: raw, log, ...(platformSkills === undefined ? {} : { platformSkills }) });
    // The nightly skill-evolution job (BACKEND §5.15): outcome labels, canary verdicts, and the platform reflector when a model is configured.
    const platformModel = readPlatformModelEnv(process.env);
    const evolutionDeps = raw === undefined || platformSkills === undefined ? undefined : {
      db: raw, log, platform: platformSkills, ...(skills === undefined ? {} : { skills }), ...(platformModel === undefined ? {} : { complete: createChatComplete(platformModel) }),
    };
    const stopEvolution = evolutionDeps === undefined ? () => undefined : startSkillEvolution(evolutionDeps);
    const stopEvaluation = (): void => { stopWeekly(); stopEvolution(); };
    const stopPush = await startPushNotifications({ store, bus, env: process.env });
    // The thumbnail backfill (BACKEND 5.11): only with Postgres (raw SQL over the library) and a sandbox; it probes owners' computers passively.
    const stopThumbnails = raw === undefined ? () => undefined : startThumbnailBackfill({ store, blobs: core.blobs, computer, computerd, candidates: rawThumbnailCandidates(raw), log });
    const stopChannelDelivery = await startChannelDelivery({ store, bus, senders: channels.senders() });
    // A change of who holds a screen or the Mac (computerd's control gateway) becomes a note to the agent; a Mac Stop has no agentd route, only this event.
    const stopControlNotices = await startControlNotices({ deps: { store, enqueuer: core.enqueuer }, bus, computerd });
    const stopChannelRunners = startChannelRunners({ store, enqueuer: core.enqueuer, channels, blobs: core.blobs, ...(memory === undefined ? {} : { identity: memory.graph.identity }), ...(computerd.home === undefined ? {} : { home: computerd.home }) });

    // Account deletion needs raw SQL for its bulk deletes; only the in-memory test store lacks it.
    const accountEraser = store.raw === undefined ? undefined : createAccountEraser({ store, raw: store.raw, bus, enqueuer: core.enqueuer, config, computerd, blobs: core.blobs, channels, ...(core.runner === undefined ? {} : { runner: core.runner }) });

    const app = createInternalAgentApp({
      store,
      bus,
      enqueuer: core.enqueuer,
      config,
      channels,
      blobs: core.blobs,
      appCatalog: catalog,
      computerd,
      pluginRoutes: plugins.routes(),
      ...(accountEraser === undefined ? {} : { accountEraser }),
      // LEAK: the channel ingress records speakers on the identity graph; it is not behind the memory port yet.
      ...(memory === undefined ? {} : { identity: memory.graph.identity, memory: memoryPort }),
      ...(skills === undefined ? {} : { skills }),
      ...(evolutionDeps === undefined ? {} : { evolution: createEvolutionControl(evolutionDeps) }),
      ...(runner === undefined ? {} : { runNow: (service: string, key: string, input: unknown) => runner.invoke({ service, key, handler: 'runNow', input }) }),
      internalToken: config.INTERNAL_AGENTD_TOKEN,
    });

    let boundPort = 0;
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const created = serve(
        { fetch: app.fetch, port: listenPort, hostname: '127.0.0.1' },
        (info) => {
          boundPort = info.port;
          log.info({ address: info.address, port: info.port }, `✓ Internal agentd on http://${info.address}:${info.port}`);
          resolve(created);
        },
      );
    });

    // Both roles register the services (the routes enqueue work by service name). In `all` mode this process also claims and runs
    // it; a `coordinator`'s runner has `execute: false`, so it only stores the work for the workers.
    const execution = await startExecutionOf(core, config).catch(async (error: unknown) => {
      log.error({ err: error }, 'Execution failed to start');
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    });
    // Timer arming is coordinator maintenance (one process, so no race between "is it live" and "arm it").
    if (runner !== undefined) await armMissingTimers({ store, runner, enqueuer: core.enqueuer });

    // The runner is up: finish any account deletion a restart interrupted (the marker table lists them).
    await accountEraser?.resume().then((count) => { if (count > 0) log.warn({ count }, 'Resumed interrupted account deletions'); }).catch((error: unknown) => log.error({ err: error }, 'Could not resume account deletions'));

    const stop = async (): Promise<void> => {
      accountEraser?.stop();
      // SSE clients hold connections open, so bound the drain: stop accepting, drop keep-alive
      // sockets, then force the remainder closed after a short grace period.
      const stopHttp = new Promise<void>((resolve) => {
        const drain = setTimeout(() => {
          log.warn('HTTP drain timed out; closing remaining connections');
          closeServerConnections(server, 'all');
        }, 3_000);
        drain.unref();
        server.close(() => {
          clearTimeout(drain);
          resolve();
        });
        closeServerConnections(server, 'idle');
      });
      clearInterval(pruneTimer);
      stopPresence();
      stopVoiceCalls();
      stopEvaluation();
      stopThumbnails();
      stopPush?.();
      stopChannelDelivery();
      stopControlNotices();
      stopChannelRunners();
      await Promise.allSettled([stopHttp, execution.stop()]);
      // Executors are stopped before the drain marker: no worker claims new work while the coordinator leaves.
      await coordination?.stop();
      await core.close();
    };
    return { port: boundPort, server, role, stop };
  } catch (error) {
    await coordination?.stop().catch(() => undefined);
    await core.close().catch(() => undefined);
    throw error;
  }
}

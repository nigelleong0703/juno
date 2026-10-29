/**
 * Independent agent runtime: brain, tools plus the Session, Run and
 * RoutineTimer services, composed from injected dependencies.
 *
 * No HTTP listener, no Restate registration and no routine bootstrap here: the
 * host owns the endpoint and scheduling. Everything the runtime needs (store,
 * config, enqueuer, and optionally the sandbox client, model provider and log
 * sink) is injected, so the same factory runs in production and in tests.
 */
import type { BlobStore, Enqueuer, Store, ToolRegistry } from './contracts/index.js';
import type { BackendConfig } from './execution/config.js';
import { createBrain } from './execution/brain/index.js';
import { HarnessPins, type HarnessVersionStore } from './modules/harness/store.js';
import type { ModelProvider } from './execution/brain/index.js';
import { getModelCatalogLoader, readModelEnv } from './execution/brain/model-catalog.js';
import { readFastModelEnv } from './execution/brain/fast-model.js';
import { currentOwnerId } from './owner-context.js';
import { readSystemOneEnv, resolveSystemOne } from './execution/brain/system-one.js';
import { createAccountModelSelection } from './execution/brain/model-selection.js';
import { createTaskWatcherService, createBackgroundCallService, createMemoryTimerService, createIdeasTimerService, createCalendarTimerService, createChatDigestService } from './execution/harness/index.js';
import type { MemoryPort } from './modules/memory/port.js';
import type { PlatformSkillsService, SkillsService } from '@agent-desktop/memory-graph/skills';
import type { VoicePort } from './modules/tools/tools/discordVoice.js';
import type { ChannelPort } from './modules/tools/tools/channelHistory.js';
import { createExecutionTools } from './execution/mcp-runtime.js';
import type { ComputerClient } from './modules/tools/index.js';
import { macUsable } from './modules/tools/tools/macApps.js';
import type { PluginTool } from './modules/tools/plugin-tool.js';
import type { ConnectorCatalog } from './modules/mcp/catalog.js';
import {
  createRoutineTimerService,
  createRunWorkflow,
  createSessionService,
} from './execution/harness/index.js';
import { platformModelConfigured, selectProvider } from './execution/provider.js';
import { createWebSearchProvider } from './modules/tools/web/searchProvider.js';
import { requestScopedStore } from './owner-context.js';

export type VomuLog = (fields: Record<string, unknown>, message: string) => void;

export interface VomuAgentOptions {
  store: Store;
  /** Where file bytes live (BACKEND §5.2a); the host builds it once (packages/db createBlobStore). */
  blobs: BlobStore;
  config: BackendConfig;
  enqueuer: Enqueuer;
  env?: NodeJS.ProcessEnv;
  computer?: ComputerClient;
  provider?: ModelProvider;
  /** Memory (Postgres): the items, the people and the relations, behind the port. Without it (no Postgres) memory is not offered and the memory jobs do not run. */
  memory?: MemoryPort;
  /** Versioned skills (Postgres): the selected skills load through it, and the skill tools and the dependency recheck read it. */
  skills?: SkillsService;
  /** The platform skills as versioned rows (Postgres): skill_read serves them and records which version each run read. */
  platformSkills?: PlatformSkillsService;
  /** Discord voice, held by the host that owns the gateway; absent leaves the voice tools out. */
  voice?: VoicePort;
  /** Tools the host's plugins added (fixed for this agent's life); see modules/tools/plugin-tool.ts. */
  pluginTools?: readonly PluginTool[];
  /** Static system-prompt sections the host's plugins added (text, in order); fixed for this agent's life. */
  promptSections?: readonly string[];
  /** Whether monitors run (false while the host's monitors plugin is off: their routines are kept and paused). Absent: they run. */
  monitorChecks?: boolean;
  /** Chat-platform calls the chat tools make (reactions, earlier messages), held by the host with the credentials; absent: those tools say "not available here". */
  channels?: ChannelPort;
  /** The connectors this deployment offers, built once from the loaded plugins; connector_search, connect_request, Ideas and the MCP runtime all read this one catalog. */
  connectorCatalog: ConnectorCatalog;
  /** The harness versions in the database (migration 0053); absent (the in-memory store) every session reads the repository seed. */
  harnessVersions?: HarnessVersionStore;
  log?: VomuLog;
}

export interface VomuAgent {
  store: Store;
  config: BackendConfig;
  enqueuer: Enqueuer;
  brain: Awaited<ReturnType<typeof createBrain>>;
  /** H-72: watches background processes and reports their end to the session. */
  watcher: ReturnType<typeof createTaskWatcherService>;
  /** H-73: runs authorized background MCP calls and reports them to the session. */
  backgroundCall: ReturnType<typeof createBackgroundCallService>;
  tools: ToolRegistry;
  session: ReturnType<typeof createSessionService>;
  run: ReturnType<typeof createRunWorkflow>;
  timer: ReturnType<typeof createRoutineTimerService>;
  /** The hourly and nightly memory jobs, one hidden schedule per user (BACKEND §5.4). */
  memoryTimer: ReturnType<typeof createMemoryTimerService>;
  ideasTimer: ReturnType<typeof createIdeasTimerService>;
  /** Wakes the agent when an item of its own calendar is due. */
  calendarTimer: ReturnType<typeof createCalendarTimerService>;
  /** Runs the chat digest (memory, goal progress, group note) of a conversation once it has been quiet (BACKEND §5.4). */
  chatDigest: ReturnType<typeof createChatDigestService>;
}

export async function createVomuAgent(opts: VomuAgentOptions): Promise<VomuAgent> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  // Background services capture the owner-scoped facade; each handler re-enters its wake
  // owner's scope, so every read, write and emitted event resolves to that owner instead of
  // the raw store's unknown default. Outside a scope it delegates raw.
  const store = requestScopedStore(opts.store);
  const config = opts.config;
  const enqueuer = opts.enqueuer;
  // One explicit pricing source for this runtime: config JSON wins over env JSON, resolved once
  // here so the bootstrap provider and every account-selected run price the same model identically.
  const envPricing = env['MODEL_PRICING_JSON'] ?? '';
  const pricedConfig = config.MODEL_PRICING_JSON.length > 0 || envPricing.length === 0 ? config : { ...config, MODEL_PRICING_JSON: envPricing };
  const provider = opts.provider ?? selectProvider(env, pricedConfig, log);
  // Account-wide model choice: resolved once per new run from the owner's stored setting and
  // frozen on the run context. Scripted test doubles stay exactly as before (no selection).
  // The platform default is present when MODEL_* is configured (or a bootstrap provider was injected).
  // Owners without a provider of their own use it; without it they must add one.
  const scripted = env['MODEL_PROVIDER'] === 'scripted';
  const modelEnv = scripted || !(platformModelConfigured(env) || opts.provider !== undefined) ? undefined : readModelEnv(config, env);
  const systemEnv = scripted ? undefined : readFastModelEnv(config);
  const modelSelection =
    scripted
      ? undefined
      : createAccountModelSelection({ store, config: pricedConfig, ...(modelEnv === undefined ? {} : { env: modelEnv, catalog: getModelCatalogLoader(modelEnv) }), ...(systemEnv === undefined ? {} : { systemEnv }) });
  const computer = opts.computer;
  const environment = computer === undefined ? undefined : memoEnvironment((agentId, on) => computer.environment(agentId, AbortSignal.timeout(15_000), on));
  const systemOne = scripted ? undefined : readSystemOneEnv(config);
  const blobs = opts.blobs;
  const brain = await createBrain({
    ...(opts.platformSkills === undefined ? {} : { platformSkills: opts.platformSkills }),
    store,
    blobs,
    harness: new HarnessPins(opts.harnessVersions),
    ...(systemOne === undefined ? {} : { systemOne }),
    ...(opts.promptSections === undefined ? {} : { promptSections: opts.promptSections }),
    connectorCatalog: opts.connectorCatalog,
    ...(provider === undefined ? {} : { provider }),
    ...(modelSelection ? { modelSelection } : {}),
    ...(environment ? { environment } : {}),
    home: { ...(computer?.home === undefined ? {} : { home: computer.home }), ...(opts.memory === undefined ? {} : { memory: opts.memory }), ...(opts.skills === undefined ? {} : { skills: opts.skills }), log },
  });
  // Misconfigured SEARCH_PROVIDER / SEARCH_API_KEY throws here, at boot, not on the first search.
  const webSearch = createWebSearchProvider(config);
  const tools = await createExecutionTools({ store, enqueuer, ...(opts.memory === undefined ? {} : { memory: opts.memory }), ...(opts.skills === undefined ? {} : { skills: opts.skills }), ...(opts.platformSkills === undefined ? {} : { platformSkills: opts.platformSkills }), ...(env['BROWSER_GOAL_INTERFACE'] === '1' ? { nativeBrowserAvailable: async () => { const owner = currentOwnerId(); return owner ? (await resolveSystemOne(store, owner, systemOne)) !== undefined : systemOne !== undefined; } } : {}), jev: { config }, ...(computer ? { computer } : {}), ...(webSearch ? { webSearch } : {}), ...(opts.voice ? { voice: opts.voice } : {}), ...(opts.pluginTools ? { pluginTools: opts.pluginTools } : {}), ...(opts.channels ? { channels: opts.channels } : {}), connectorCatalog: opts.connectorCatalog });
  const session = createSessionService({ store, brain, toolRegistry: tools });
  const run = createRunWorkflow({ store, blobs, enqueuer, brain, toolRegistry: tools, log, ...(computer?.home === undefined ? {} : { home: computer.home }) });
  // The run context tells a scheduled routine what it can use: web search and a computer exist only when registered.
  const timer = createRoutineTimerService({ store, enqueuer, tools, blobs, ...(opts.monitorChecks === undefined ? {} : { monitorChecks: opts.monitorChecks }), capabilities: { webSearch: tools.get('web_search') !== undefined, computer: tools.get('computer.screenshot') !== undefined }, ...(computer ? { macUsable: (agentId: string) => macUsable(store, () => computer, agentId) } : {}) });
  const memoryTimer = createMemoryTimerService({
    store, brain, log,
    ...(computer?.home === undefined ? {} : { home: computer.home }),
    ...(opts.memory === undefined ? {} : { memory: opts.memory }),
  });
  const ideasTimer = createIdeasTimerService({ store, brain, tools, log, catalog: opts.connectorCatalog,...(computer?.home === undefined ? {} : { home: computer.home }) });
  const calendarTimer = createCalendarTimerService({ store });
  // How long a chat must be quiet before its digest runs; e2e shortens it, real runs call runNow.
  const quietMs = Number(env['CHAT_DIGEST_QUIET_MS']);
  const chatDigest = createChatDigestService({
    store, brain, log, quietMs: Number.isFinite(quietMs) && quietMs > 0 ? quietMs : 10 * 60_000,
    ...(opts.memory === undefined ? {} : { memory: opts.memory }),
    ...(opts.channels === undefined ? {} : { channels: opts.channels }),
    ...(computer?.home === undefined ? {} : { home: computer.home }),
  });
  const watcher = createTaskWatcherService(computer === undefined ? { store } : { computer, store });
  const backgroundCall = createBackgroundCallService({ store, blobs, enqueuer, toolRegistry: tools });
  return { store, config, enqueuer, brain, tools, session, run, timer, memoryTimer, ideasTimer, calendarTimer, chatDigest, watcher, backgroundCall };
}

/**
 * The context is rebuilt at every model step, and each build asks the computer who it is. A step lasts
 * seconds, so one probe answers all of them: a paused or recreated computer is still noticed on the
 * next step or run, and a long task stops paying the probe (15s bound, usually milliseconds) per step.
 */
function memoEnvironment<E>(load: (agentId: string, on?: 'mac') => Promise<E>, ttlMs = 5_000): (agentId: string, on?: 'mac') => Promise<E> {
  const seen = new Map<string, { at: number; value: Promise<E> }>();
  return (agentId, on) => {
    const key = agentId + ':' + (on ?? 'sandbox');
    const hit = seen.get(key);
    if (hit !== undefined && Date.now() - hit.at < ttlMs) return hit.value;
    const value = load(agentId, on);
    seen.set(key, { at: Date.now(), value });
    // A failed probe is not kept: the next step retries it.
    value.catch(() => seen.delete(key));
    return value;
  };
}

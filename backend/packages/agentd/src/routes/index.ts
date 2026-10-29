/**
 * API routes for agentd (Stream B).
 * Public REST API endpoints (BACKEND.md §10.2).
 * All endpoints require bearer auth.
 */

import { type Hono } from 'hono';
import type { Store, Enqueuer, EventBus, BlobStore } from '@agent-desktop/contracts';
import { bearerAuth } from '../auth.js';
import type { AuthOptions } from '../auth.js';
import type { Identity } from '@agent-desktop/memory-graph/identity';
import type { MemoryPort } from 'juno-agent/modules/memory/port';
import type { ComputerdClient } from '../computerd.js';
import { registerAgents } from './agents.js';
import { registerAgentTasks } from './agent-tasks.js';
import { registerConversations } from './conversations.js';
import { registerItems } from './items.js';
import { registerAguiRuns } from './agui-runs.js';
import { registerRuns } from './runs.js';
import { registerModels } from './models.js';
import { registerModelProviders } from './model-providers.js';
import { registerRequests } from './requests.js';
import { registerDocuments } from './documents.js';
import { registerRoutines } from './routines.js';
import { registerRules } from './rules.js';
import { registerDelegations } from './delegations.js';
import { registerMemory } from './memory.js';
import { registerPeople } from './people.js';
import { registerGoals } from './goals.js';
import { registerMeals } from './meals.js';
import { registerCalendar } from './calendar.js';
import { registerTranscriptions } from './transcriptions.js';
import { registerSpeech, type Speaker } from './speech.js';
import { registerIdeas } from './ideas.js';
import { registerFeed } from './feed.js';
import { registerProactive } from './proactive.js';
import { registerToday } from './today.js';
import { registerInspiration } from './inspiration.js';
import { registerDevices } from './devices.js';
import { registerPhone } from './phone.js';
import { registerSkills } from './skills.js';
import { registerComputers } from './computers.js';
import { registerMac, registerMacApps } from './mac.js';
import { registerSecureInput } from './secure-input.js';
import { registerSecureVault } from './secure-vault.js';
import { registerOnboarding } from './onboarding.js';
import { registerProfile } from './profile.js';
import { registerHooks } from './hooks.js';
import { registerChannels } from './channels.js';
import type { SkillsService } from '@agent-desktop/memory-graph/skills';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { PluginRoute } from '../plugins/host.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { StoredCatalog } from 'juno-agent/modules/apps/catalog';
import type { McpManager } from 'juno-agent/modules/mcp/index';
import { registerApps } from './apps.js';
import { registerHome } from './home.js';
import { registerAccount } from './account.js';
import type { AccountEraser } from '../account/erase.js';

export interface AgentdDeps {
  store: Store;
  bus: EventBus;
  enqueuer: Enqueuer;
  config?: Record<string, unknown>;
  /** computerd's internal API; absent keeps the screen routes out of the app. */
  computerd?: ComputerdClient;
  /** The versioned skill store (Postgres); absent without Postgres, and then the skill routes answer 503 and no skill can be selected. */
  skills?: SkillsService;
  /** The identity graph (people and accounts); absent when there is no Postgres (tests with the in-memory store), and nothing is recorded. */
  identity?: Identity;
  /** Memory (Postgres); absent without it, and then forgetting is refused (503). */
  memory?: MemoryPort;
  /** Deletes a whole account and its data (`DELETE /v1/account`); absent keeps the route out of the app. */
  accountEraser?: AccountEraser;
  /** Session/token resolver plus the request owner-scope hook (no globals). */
  auth?: AuthOptions;
  /** The chat platforms the loaded plugins registered: connect, webhook admission and replies look a platform up here. */
  channels: ChannelRegistry;
  /** The app catalog table (BACKEND 10.18): what the Apps page lists, and what the admin routes edit. Absent lists no app. */
  appCatalog?: StoredCatalog;
  /** Lists an app's tools for its capability list on the Apps page; absent leaves that list empty. */
  mcp?: McpManager;
  /** The blob store: platform files a chat message carries are kept there (through the library), as app uploads are. */
  blobs?: BlobStore;
  /** Fetch for the Telegram Bot API (connect, bind confirmation); absent uses the global fetch. Tests inject a fake. */
  channelFetch?: typeof fetch;
  /** Feishu `registerApp` (device-flow app creation); absent uses the SDK's. Tests inject a fake. */
  feishuRegisterApp?: FeishuRegisterApp;
  /** Text-to-speech sidecar client; absent uses the one TTS_ENABLED configures. */
  speaker?: Speaker;
  /** The HTTP routes the loaded plugins registered (`ctx.http.route`); production passes the host's list, absent adds none. */
  pluginRoutes?: readonly PluginRoute[];
}

/** The SDK's `registerApp`; deps can swap it so tests never reach Feishu. */
export type FeishuRegisterApp = typeof lark.registerApp;

export function registerRoutes(app: Hono, deps: AgentdDeps) {
  app.use('/v1/*', bearerAuth(deps.auth));

  registerAgents(app, deps);
  registerAgentTasks(app, deps);
  registerHome(app, deps);
  registerModels(app, deps);
  registerModelProviders(app, deps);
  registerConversations(app, deps);
  registerItems(app, deps);
  registerAguiRuns(app, deps);
  registerRuns(app, deps);
  registerRequests(app, deps);
  registerDocuments(app, deps);
  registerRoutines(app, deps);
  registerRules(app, deps);
  registerDelegations(app, deps);
  registerMemory(app, deps);
  registerPeople(app, deps);
  registerGoals(app, deps);
  registerMeals(app, deps);
  registerCalendar(app, deps);
  registerTranscriptions(app);
  registerSpeech(app, deps.speaker);
  registerIdeas(app, deps);
  registerFeed(app, deps);
  registerProactive(app, deps);
  registerToday(app, deps);
  registerInspiration(app, deps);
  registerDevices(app, deps);
  registerPhone(app, deps);
  registerSecureVault(app, deps);
  registerProfile(app, deps);
  registerOnboarding(app, deps);
  if (deps.accountEraser) registerAccount(app, deps.accountEraser);
  registerSkills(app, deps);
  registerMacApps(app, deps);
  if (deps.computerd) {
    registerMac(app, { ...deps, computerd: deps.computerd });
    registerComputers(app, { ...deps, computerd: deps.computerd });
    registerSecureInput(app, { ...deps, computerd: deps.computerd });
  }
  registerHooks(app, deps);
  registerChannels(app, deps);
  registerApps(app, deps);
  // The HTTP routes the loaded plugins added (a platform's shared events, its OAuth redirect, ...): after the bearer middleware above,
  // so they are authenticated like the core routes. A disabled or failed plugin contributes none, so its paths answer 404.
  for (const route of deps.pluginRoutes ?? []) app.on(route.method.toUpperCase(), route.path, (c) => route.handler(c, deps));
}

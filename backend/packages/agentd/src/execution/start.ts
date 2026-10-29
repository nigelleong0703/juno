/**
 * Execution service: the durable runner (Session/Run/RoutineTimer/...) in the agentd process.
 *
 * Host bootstrap: the agent runtime (brain, tools, session/run/timer composition) comes from the public
 * juno-agent factory, which opens no listener. This host registers its services with the runner, starts it
 * (which resumes whatever a crash interrupted; a coordinator-role runner only registers, it claims nothing), and
 * injects the computer owner resolution and client selection into the factory. The caller owns shutdown via
 * the returned runtime.
 */

import type { Runner } from '@agent-desktop/durable';
import type { BlobStore, Enqueuer, Store } from '@agent-desktop/contracts';
import { createVomuAgent, type BackendConfig } from 'juno-agent';
import type { ConnectorCatalog } from 'juno-agent/modules/mcp/catalog';
import type { HarnessVersionStore } from 'juno-agent/modules/harness/store';
import {
  createComputerOwnerResolver,
  createMacAccessResolver,
  selectComputerdClient,
} from 'juno-agent/execution/infrastructure/computerd-executor/index';
import type { MemoryPort } from 'juno-agent/modules/memory/port';
import type { PlatformSkillsService, SkillsService } from '@agent-desktop/memory-graph/skills';
import type { VoicePort } from 'juno-agent/modules/tools/tools/discordVoice';
import type { PluginTool } from 'juno-agent/modules/tools/plugin-tool';
import type { ComputerClient } from 'juno-agent/computer';
import { createLogger } from '@agent-desktop/log';
import { requestScopedStore } from '../owner-scope.js';
import { runWithOwner } from 'juno-agent/owner-context';
import { getConfig } from '../config.js';
import type { ComputerdClient } from '../computerd.js';
import { createChannelPort } from '../channels/port.js';
import type { ChannelRegistry } from '../channels/registry.js';
import { ensureComputer } from '../routes/computer-projection.js';

const log = createLogger({ service: 'agentd-execution' });

export interface ExecutionOptions {
  store: Store;
  /** Where file bytes live (BACKEND §5.2a). */
  blobs: BlobStore;
  config: BackendConfig;
  /** The durable runner the services register with; started here. */
  runner: Runner;
  /** Shared with the HTTP layer (backed by the same runner). */
  enqueuer: Enqueuer;
  /** Memory (Postgres); absent without it, and then memory, person_link and the memory jobs are off. */
  memory?: MemoryPort;
  /** The versioned skill store (Postgres); absent, and then no selected skill loads. */
  skills?: SkillsService;
  /** The platform skills as versioned rows (Postgres); skill_read serves them. */
  platformSkills?: PlatformSkillsService;
  /** The harness versions (migration 0053); sessions pin the version their frozen system row names. */
  harnessVersions?: HarnessVersionStore;
  env?: NodeJS.ProcessEnv;
  /** The agents' sandbox client (`createExecutionComputer`); absent when no sandbox backend is configured. */
  computer?: ComputerClient;
  /** Discord voice sessions; the voice tools are offered to agents with a discord channel. */
  voice?: VoicePort;
  /** The tools the loaded plugins added; read once here, so they are fixed for this process. */
  pluginTools?: readonly PluginTool[];
  /** The static system-prompt sections the loaded plugins added (text, in order); read once here, so they are fixed for this process. */
  promptSections?: readonly string[];
  /** Whether monitors run: the monitors plugin is active. False pauses their routines (kept, not deleted). */
  monitorChecks?: boolean;
  /** The chat platforms the loaded plugins registered; the chat tools' ChannelPort looks them up here. */
  channels: ChannelRegistry;
  /** The connectors the loaded plugins registered (boot builds it once and also serves it to the gateway). */
  connectorCatalog: ConnectorCatalog;
}

export interface ExecutionRuntime {
  stop: () => Promise<void>;
}

/**
 * The sandbox client the agents' computer tools use. agentd boot builds it once and offers it to plugins as the `computer`
 * service before it starts execution with the same instance.
 */
export function createExecutionComputer(opts: { store: Store; config: BackendConfig; env?: NodeJS.ProcessEnv; computerd?: ComputerdClient }): ComputerClient | undefined {
  // Owner-scoped reads for the computer owner lookup: each call resolves the wake owner
  // instead of the raw store default. The factory scopes its own runtime the same way.
  const scoped = requestScopedStore(opts.store);
  const resolveComputerOwner = createComputerOwnerResolver(
    { getAgent: (agentId: string) => scoped.get('agents', agentId) },
  );
  const computer = selectComputerdClient(
    opts.env ?? process.env,
    opts.config,
    (fields, message) => log.info(fields, message),
    resolveComputerOwner,
    createMacAccessResolver({ getAgent: (agentId: string) => scoped.get('agents', agentId) }),
  );
  // An agent starting to use its sandbox goes through the same ensureComputer as the owner's "Set up computer": the
  // sandbox is connected (created when missing), the owner's computer row recorded, and the agent's display allocated.
  const computerd = opts.computerd;
  return computer === undefined || computerd === undefined ? computer : {
    ...computer,
    async ensureScreen(agentId: string, signal: AbortSignal) {
      const owner = await resolveComputerOwner(agentId);
      const store = opts.store.forOwner?.(owner);
      if (store === undefined) throw new Error('Store.forOwner is required to record the owner computer');
      await runWithOwner(owner, () => ensureComputer(store, computerd, owner, agentId, getConfig().COMPUTER_RESOLUTION, signal));
    },
  };
}

export async function startExecution(opts: ExecutionOptions): Promise<ExecutionRuntime> {
  const env = opts.env ?? process.env;
  const config = opts.config;
  const { runner, enqueuer } = opts;
  log.info('Execution starting');
  const agent = await createVomuAgent({
    store: opts.store,
    blobs: opts.blobs,
    config,
    enqueuer,
    env,
    ...(opts.computer ? { computer: opts.computer } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
    ...(opts.skills ? { skills: opts.skills } : {}),
    ...(opts.platformSkills ? { platformSkills: opts.platformSkills } : {}),
    ...(opts.harnessVersions ? { harnessVersions: opts.harnessVersions } : {}),
    ...(opts.voice ? { voice: opts.voice } : {}),
    ...(opts.pluginTools ? { pluginTools: opts.pluginTools } : {}),
    ...(opts.promptSections ? { promptSections: opts.promptSections } : {}),
    ...(opts.monitorChecks === undefined ? {} : { monitorChecks: opts.monitorChecks }),
    connectorCatalog: opts.connectorCatalog,
    channels: createChannelPort({ store: opts.store, channels: opts.channels }),
    log: (fields, message) => log.info(fields, message),
  });

  runner.register(agent.session, agent.run, agent.timer, agent.memoryTimer, agent.ideasTimer, agent.calendarTimer, agent.chatDigest, agent.watcher, agent.backgroundCall);
  await runner.start();
  log.info('Execution running');

  return {
    stop: async () => {
      try { await runner.stop(); }
      finally { await agent.tools.close?.(); }
    },
  };
}

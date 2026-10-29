/**
 * The production MCP composition used by the execution service.
 *
 * The manager is owner-scoped (its identity comes from the trusted owner in scope, never a stored
 * guess) and its stdio bridge is resolved PER AGENT, so a configured stdio server runs inside THAT
 * agent's bound computer. With no sandbox client there is no stdio bridge at all — stdio is refused
 * with an explicit unsupported error while HTTP servers keep working. The host never spawns a server.
 */
import type { Enqueuer, Store, ToolRegistry } from '../contracts/index.js';
import type { BackendConfig } from './config.js';
import type { ConnectorCatalog, McpManager } from '../modules/mcp/index.js';
import type { MemoryPort } from '../modules/memory/port.js';
import type { PlatformSkillsService, SkillsService } from '@agent-desktop/memory-graph/skills';
import { createMcpManager } from '../modules/mcp/index.js';
import { createToolRegistry, type ComputerClient } from '../modules/tools/index.js';
import type { PluginTool } from '../modules/tools/plugin-tool.js';
import type { WebSearchProvider } from '../modules/tools/web/searchProvider.js';
import type { VoicePort } from '../modules/tools/tools/discordVoice.js';
import type { ChannelPort } from '../modules/tools/tools/channelHistory.js';
import { createSandboxStdioBridge } from '../modules/tools/tools/mcpStdio.js';
import { createChildDispatchAdapter } from './child-dispatch.js';
import { createJevGatedManager, createJevMcpRuntime } from './jev-browser-gate.js';

/** The MCP runtime for one execution: owner-scoped manager, per-agent sandbox stdio bridge. */
export function createMcpRuntime(computer: ComputerClient | undefined, catalog?: ConnectorCatalog): McpManager {
  const withCatalog = catalog === undefined ? {} : { catalog };
  if (computer === undefined) return createMcpManager(withCatalog);
  const client = computer;
  return createMcpManager({
    ...withCatalog,
    stdioForAgent: ({ agentId }) =>
      agentId === undefined || agentId === '' ? undefined : createSandboxStdioBridge({ client, agentId }),
  });
}

/**
 * The production tool assembly: built-ins, the computer seam when configured, and the MCP runtime.
 * `startExecution` calls exactly this, so a running deployment exposes configured MCP servers.
 */
export async function createExecutionTools(input: {
  store: Store;
  nativeBrowserAvailable?(agentId: string): Promise<boolean>;
  enqueuer: Enqueuer;
  computer?: ComputerClient;
  webSearch?: WebSearchProvider;
  /** Memory (Postgres deployments): memory_note, person_link and the memory reads are offered only with it. */
  memory?: MemoryPort;
  /** The versioned skill store (Postgres); the skill tools read it when present. */
  skills?: SkillsService;
  /** The platform skills as versioned rows (Postgres); skill_read serves them and records the exposure. */
  platformSkills?: PlatformSkillsService;
  voice?: VoicePort;
  pluginTools?: readonly PluginTool[];
  channels?: ChannelPort;
  /** The connectors this deployment offers; connector_search / connect_request read it and a stored connection to a connector outside it is not used. */
  connectorCatalog?: ConnectorCatalog;
  jev?: { config: BackendConfig };
  /** Tests pass their own manager so teardown can `close()` the sessions it opened. */
  mcp?: McpManager;
}): Promise<ToolRegistry> {
  const baseMcp = input.mcp ?? (input.jev === undefined
    ? createMcpRuntime(input.computer, input.connectorCatalog)
    : createMcpManager({ ...createJevMcpRuntime({ computer: input.computer, store: input.store, config: input.jev.config }), ...(input.connectorCatalog === undefined ? {} : { catalog: input.connectorCatalog }) }));
  // Gate persisted managed connections even when the feature is currently disabled.
  const mcp = input.jev === undefined ? baseMcp : createJevGatedManager(baseMcp, input.store, input.jev.config);
  return createToolRegistry({
    store: input.store,
    ...(input.nativeBrowserAvailable ? { nativeBrowserAvailable: input.nativeBrowserAvailable } : {}),
    enqueuer: input.enqueuer,
    ...(input.computer === undefined ? {} : { computer: () => input.computer }),
    ...(input.webSearch === undefined ? {} : { webSearch: input.webSearch }),
    ...(input.memory === undefined ? {} : { memory: input.memory }),
    ...(input.skills === undefined ? {} : { skills: input.skills }),
    ...(input.platformSkills === undefined ? {} : { platformSkills: input.platformSkills }),
    ...(input.voice === undefined ? {} : { voice: input.voice }),
    ...(input.pluginTools === undefined ? {} : { pluginTools: input.pluginTools }),
    ...(input.channels === undefined ? {} : { channels: input.channels }),
    ...(input.connectorCatalog === undefined ? {} : { connectorCatalog: input.connectorCatalog }),
    mcp,
    // PH12: the production child-run dispatcher, so a spawned child is a real run keyed by its id.
    childDispatch: createChildDispatchAdapter({ store: input.store, enqueuer: input.enqueuer }),
  });
}

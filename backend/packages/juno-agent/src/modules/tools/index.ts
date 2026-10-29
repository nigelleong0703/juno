/**
 * Tool registry and built-in tools.
 * Implements BACKEND.md §4: state_update, wake_at, wait_for, send_message, etc.
 */

import type { Tool, ToolRegistry, Store, Enqueuer } from '../../contracts/index.js';
import { createConnectorCatalog, sharedRoomCatalogIds, type ConnectorCatalog, type McpManager } from '../mcp/index.js';
import { createStateUpdateTool } from './tools/stateUpdate.js';
import { createWakeAtTool } from './tools/wakeAt.js';
import { createWaitForTool } from './tools/waitFor.js';
import { createTodoWriteTool } from './tools/todoWrite.js';
import { createSendMessageTool } from './tools/sendMessage.js';
import { createMessageAgentTool } from './tools/messageAgent.js';
import { createPostToRoomTool } from './tools/postToRoom.js';
import { createHandoffTool } from './tools/handoff.js';
import { createAgentCreateTool } from './tools/agentCreate.js';
import { createAgentDirectoryTool } from './tools/agentDirectory.js';
import { createConversationListTool } from './tools/conversationList.js';
import { createConversationCreateTool } from './tools/conversationCreate.js';
import { createAttachmentReadTool } from './tools/attachmentRead.js';
import { createSendFileTool } from './tools/sendFile.js';
import { createArtifactPublishTool } from './tools/artifactPublish.js';
import { createSpacePublishTool } from './tools/spacePublish.js';
import { createAgentUpdateTool } from './tools/agentUpdate.js';
import { createMemoryExplainTool, createMemorySearchTool } from './tools/memoryTools.js';
import { createMemoryNoteTool } from './tools/memoryNote.js';
import { createPersonLinkTool } from './tools/personLink.js';
import { createPersonLookupTool } from './tools/personLookup.js';
import type { MemoryPort } from '../memory/port.js';
import type { PlatformSkillsService, SkillsService } from '@agent-desktop/memory-graph/skills';
import { createReactTool } from './tools/react.js';
import { createChannelHistoryTool, type ChannelPort } from './tools/channelHistory.js';
import { createGroupRuleTool } from './tools/groupRule.js';
import { createPreferenceNoteTool } from './tools/preferenceNote.js';
import { createGoalUpdateTool, createSuggestTool } from './tools/goalTools.js';
import { createMealDeleteTool, createMealLogTool, createMealSummaryTool, createMealUpdateTool } from './tools/mealTools.js';
import { createTaskUpdateTool } from './tools/taskUpdate.js';
import { createConnectRequestTool } from './tools/connectRequest.js';
import { createConnectorSearchTool } from './tools/connectorSearch.js';
import { createProfileUpdateTool } from './tools/profileUpdate.js';
import { createFeedPostTool } from './tools/feedPost.js';
import { createFinishQuietlyTool } from './tools/finishQuietly.js';
import { createDocumentCreateTool, createDocumentProposeTool, createDocumentReadTool } from './tools/documents.js';
import { createTranscriptReadTool } from './tools/transcriptRead.js';
import { createTranscriptSearchTool } from './tools/transcriptSearch.js';
import { createOutputReadTool } from './tools/outputRead.js';
import { createChildMessageTool, createChildResultsTool, createChildSpawnTool, createChildWaitTool } from '../tasks/childTools.js';
import { createChildCancelTool } from '../tasks/childControl.js';
import { createTaskStopTool, createTasksListTool } from './tools/taskTools.js';
import type { ChildDispatchAdapter } from '../tasks/child.js';
import { createComputerScreenshotTool } from './tools/computerScreenshot.js';
import { createCalendarTools } from './tools/calendarTools.js';
import { createCalendarFreeBusyTool } from './tools/calendarFreeBusy.js';
import { CALENDAR_FREE_BUSY, offeredIn, type ToolScope } from './scope.js';
import { createMacAppsTools, macUsable, MAC_APP_TOOLS } from './tools/macApps.js';
import { createComputerActTool, createComputerSnapshotTool, createComputerVerifyTool, MAC_DESKTOP_TOOL_NAMES } from './tools/computerMac.js';
import { createPhoneTools } from './tools/phoneTools.js';
import { createComputerRecordAudioTool } from './tools/computerRecordAudio.js';
import { createComputerClickTool, createComputerDoubleClickTool, createComputerMoveTool, createComputerRightClickTool } from './tools/computerMouse.js';
import { createComputerKeyTool, createComputerScrollTool, createComputerTypeTool } from './tools/computerInput.js';
import { createComputerShellTool } from './tools/computerShell.js';
import { createComputerCopyTool } from './tools/computerCopy.js';
import { createShellPollTool, createShellStartTool } from './tools/shellProcess.js';
import { createShellInputTool, createShellStopTool } from './tools/shellProcessControl.js';
import { createInstallPackagesTool } from './tools/installPackages.js';
import { createMcpDispatchTool, mcpToolsForAgent } from './tools/mcpTools.js';
import { createFileReadTool, createFileWriteTool } from './tools/computerFiles.js';
import { createSkillReadTool } from './tools/skillRead.js';
import { createSkillSearchTool, SKILL_SEARCH } from './tools/skillSearch.js';
import { createToolCallTool, createToolLoadTool, createToolSearchTool, presentForModel, TOOL_CALL, TOOL_LOAD, TOOL_SEARCH } from './tools/toolSearch.js';
import { publicParameters } from './toolArguments.js';
import { checkToolUnits, harnessToolView, isBuiltinTool } from './harness-view.js';
import { currentHarnessVersion } from '../harness/loader.js';
import { CORE_TOOL_NAMES } from './tools/namespaceDirectory.js';
import { createToolPreparer } from './tools/prepareTools.js';
import { createFileEditTool } from './tools/codingEdit.js';
import { createFileSearchTool } from './tools/codingSearch.js';
import { createBrowserNavigateTool } from './tools/computerBrowser.js';
import {
  createBrowserClickTool,
  createBrowserNewTabTool,
  createBrowserSnapshotTool,
  createBrowserTabsTool,
  createBrowserTextTool,
  createBrowserTypeTool,
  createBrowserFillTool,
} from './tools/computerBrowserActions.js';
import { createComputerEnvironmentTool } from './tools/computerEnvironment.js';
import { createRequestWithdrawTool } from './tools/requestWithdraw.js';
import { createRequestSecureInputTool, createRequestTakeoverTool } from './tools/userHandoff.js';
import { defaultEnvironmentSource, type ComputerClientProvider, type ComputerEnvironmentSource } from './computer/client.js';
import { withRecreatedNote, withRestartNote } from './computer/shared.js';
import { createBrowserDialogTool } from './tools/computerBrowserDialog.js';
import { createBrowserScrollTool } from './tools/computerBrowserScroll.js';
import { createGoalBrowserTools, GOAL_BROWSER_NAMES } from './tools/browserGoals.js';
import { createComputerBrowserAdvanceTool } from './tools/computerBrowserAdvance.js';
import { createComputerBatchTool } from './tools/computerBatch.js';
import { COMPUTER_BATCH_TOOL } from './computer/batch.js';
import { createReportToParentTool } from '../tasks/childReport.js';
import type { PluginTool } from './plugin-tool.js';
import { createWebFetchTool } from './tools/webFetch.js';
import { createWebSearchTool } from './tools/webSearch.js';
import type { WebSearchProvider } from './web/searchProvider.js';
import type { SafeFetchDeps } from './net/safeFetch.js';
import { createVoiceJoinTool, createVoiceLeaveTool, createVoiceTranscriptTool, type VoicePort } from './tools/discordVoice.js';

export interface CreateToolRegistryInput {
  nativeBrowserAvailable?(agentId: string): Promise<boolean>;
  store: Store;
  enqueuer: Enqueuer;
  config?: Record<string, unknown>;
  /**
   * The sandbox client, supplied by whoever runs the agent loop. When omitted (no COMPUTERD_URL) the computer tools
   * are not registered at all, so an agent cannot see a capability the deployment does not have.
   */
  computer?: ComputerClientProvider;
  /**
   * Optional lookup for the bound computer environment, shared once per run by every
   * computer tool. Defaults to reading it from the injected client.
   */
  computerEnvironment?: ComputerEnvironmentSource;
  /**
   * Owner-configured MCP servers. The catalog is resolved fresh for each agent and every MCP call is
   * authorized again at execute time; the registry caches nothing per owner.
   */
  mcp?: McpManager;
  /** PH12: the core's run entry, so a spawned child run id and the executed run id are the same run. */
  childDispatch?: ChildDispatchAdapter;
  /** Web search provider (SEARCH_PROVIDER). Without one, web_search is not registered; web_fetch always is. */
  webSearch?: WebSearchProvider;
  /** Test seam for web_fetch's DNS and transport. */
  webFetchDeps?: SafeFetchDeps;
  /** Memory (Postgres deployments): memory_note, person_link and person_lookup are registered only when it is here. */
  memory?: MemoryPort;
  /** The versioned skill store (Postgres): skill_read and skill_search read through it, and the preparer rechecks skill deps. */
  skills?: SkillsService;
  /** The platform skills as versioned rows (Postgres): skill_read serves their text, the canary version included, and records the exposure. Absent: read from the computer's files. */
  platformSkills?: PlatformSkillsService;
  /** Discord voice (agentd holds the gateway); the voice tools are offered only to agents with a discord channel. */
  voice?: VoicePort;
  /**
   * Tools added by host plugins, collected once when the process starts. The set is fixed for the life of this
   * registry, so a run never sees its tools change; a plugin tool may not reuse a built-in name.
   */
  pluginTools?: readonly PluginTool[];
  /** Chat-platform calls (reactions, earlier messages), held by agentd with the credentials; without it those tools answer "not available here". */
  channels?: ChannelPort;
  /** The connectors this deployment offers (built from the loaded plugins). Absent: an empty catalog, so connector_search finds nothing and connect_request refuses every id. */
  connectorCatalog?: ConnectorCatalog;
}

export async function createToolRegistry(input: CreateToolRegistryInput): Promise<ToolRegistry> {
  const { store, enqueuer, computer, mcp } = input;
  const environment = input.computerEnvironment ?? defaultEnvironmentSource(computer);
  const tools = new Map<string, Tool>();

  // Register all built-in tools
  tools.set('state_update', createStateUpdateTool({ store, enqueuer, capabilities: { webSearch: input.webSearch !== undefined, computer: computer !== undefined }, macUsable: (agentId) => macUsable(store, computer, agentId) }));
  tools.set('wake_at', createWakeAtTool({ store, enqueuer }));
  tools.set('wait_for', createWaitForTool({ store, enqueuer }));
  tools.set('request_withdraw', createRequestWithdrawTool({ store }));
  tools.set('todo_write', createTodoWriteTool({ store }));
  tools.set('send_message', createSendMessageTool({ store, enqueuer }));
  // The memory items a handoff, a message or a child task may carry along (memoryRefs): read only when there is a database.
  tools.set('message_agent', createMessageAgentTool({ store, enqueuer, ...(input.memory === undefined ? {} : { memory: input.memory }) }));
  tools.set('post_to_room', createPostToRoomTool({ store, enqueuer }));
  tools.set('handoff', createHandoffTool({ store, enqueuer, ...(input.memory === undefined ? {} : { memory: input.memory }) }));
  tools.set('agent_directory', createAgentDirectoryTool({ store }));
  tools.set('conversation_list', createConversationListTool({ store }));
  tools.set('conversation_create', createConversationCreateTool({ store }));
  tools.set('agent_create', createAgentCreateTool({ store }));
  tools.set('agent_update', createAgentUpdateTool({ store, ...(computer === undefined ? {} : { computer }) }));
  // memory_search and memory_explain read the memory items; without a database they say so when called.
  tools.set('memory_search', createMemorySearchTool(input.memory === undefined ? {} : { memory: input.memory }));
  tools.set('memory_explain', createMemoryExplainTool(input.memory === undefined ? {} : { memory: input.memory }));
  // memory_note needs the memory items (Postgres), not the computer: the computer is only where the views are written, when there is one.
  if (input.memory !== undefined) tools.set('memory_note', createMemoryNoteTool({ memory: input.memory, ...(computer === undefined ? {} : { computer }) }));
  if (input.memory !== undefined) tools.set('person_link', createPersonLinkTool({ memory: input.memory }));
  // person_lookup walks people and what they said (and, for the owner alone, their connections): it needs the memory graph.
  if (input.memory !== undefined) tools.set('person_lookup', createPersonLookupTool({ memory: input.memory }));
  tools.set('goal_update', createGoalUpdateTool());
  tools.set('task_update', createTaskUpdateTool({ store }));
  tools.set('suggest', createSuggestTool());
  for (const tool of createCalendarTools()) tools.set(tool.name, tool);
  // Calendar and Reminders on the owner's iPhone: hidden behind tool_search, refused while the app has not declared them.
  for (const tool of createPhoneTools()) tools.set(tool.name, tool);
  tools.set('meal_log', createMealLogTool());
  tools.set('meal_update', createMealUpdateTool());
  tools.set('meal_delete', createMealDeleteTool());
  tools.set('meal_summary', createMealSummaryTool());
  tools.set('react', createReactTool(input.channels));
  tools.set('channel_history', createChannelHistoryTool(input.channels));
  tools.set('group_rule', createGroupRuleTool(computer === undefined ? {} : { computer }));
  tools.set('preference_note', createPreferenceNoteTool(computer === undefined ? {} : { computer }));
  tools.set('feed_post', createFeedPostTool({ ...(input.webFetchDeps === undefined ? {} : { deps: input.webFetchDeps }) }));
  tools.set('profile_update', createProfileUpdateTool({ store }));
  tools.set('finish_quietly', createFinishQuietlyTool());
  // Documents (BACKEND 5.11a) need no computer: the text is an argument and lives in the blob store.
  tools.set('document_create', createDocumentCreateTool({ store }));
  tools.set('document_read', createDocumentReadTool({ store }));
  tools.set('document_propose', createDocumentProposeTool({ store }));
  const catalog = input.connectorCatalog ?? createConnectorCatalog([]);
  tools.set('connector_search', createConnectorSearchTool({ store, catalog, ...(computer ? { computer } : {}) }));
  tools.set('connect_request', createConnectRequestTool({ store, catalog, ...(computer ? { computer } : {}) }));
  tools.set('transcript_read', createTranscriptReadTool({ store }));
  tools.set('transcript_search', createTranscriptSearchTool());
  tools.set('attachment_read', createAttachmentReadTool());
  tools.set('output_read', createOutputReadTool());
  tools.set('child_spawn', createChildSpawnTool({ store, ...(input.childDispatch === undefined ? {} : { adapter: input.childDispatch }), ...(input.memory === undefined ? {} : { memory: input.memory }) }));
  tools.set('child_wait', createChildWaitTool());
  tools.set('child_results', createChildResultsTool());
  tools.set('child_cancel', createChildCancelTool());
  tools.set('child_message', createChildMessageTool({ store, ...(input.childDispatch === undefined ? {} : { adapter: input.childDispatch }) }));
  tools.set('report_to_parent', createReportToParentTool());
  tools.set('tasks_list', createTasksListTool({ ...(computer === undefined ? {} : { computer }) }));
  tools.set('task_stop', createTaskStopTool({ ...(computer === undefined ? {} : { computer }) }));

  // Computer tools exist only when the sandbox backend is configured; every call is scoped to ctx.agentId.
  if (computer) {
    const computerToolsFrom = tools.size;
    tools.set('computer.screenshot', createComputerScreenshotTool({ computer }));
    tools.set('computer_environment', createComputerEnvironmentTool({ computer, environment }));
    tools.set('computer.click', createComputerClickTool({ computer }));
    tools.set('computer.double_click', createComputerDoubleClickTool({ computer }));
    tools.set('computer.right_click', createComputerRightClickTool({ computer }));
    tools.set('computer.move', createComputerMoveTool({ computer }));
    tools.set('computer.type', createComputerTypeTool({ computer }));
    tools.set('computer.key', createComputerKeyTool({ computer }));
    tools.set('computer.scroll', createComputerScrollTool({ computer }));
    tools.set('computer.record_audio', createComputerRecordAudioTool({ computer }));
    for (const tool of createMacAppsTools({ computer })) tools.set(tool.name, tool);
    tools.set('computer.snapshot', createComputerSnapshotTool({ computer }));
    tools.set('computer.act', createComputerActTool({ computer }));
    tools.set('computer.verify', createComputerVerifyTool({ computer }));
    for (const tool of createGoalBrowserTools()) tools.set(tool.name, tool);
    tools.set('browser.scroll', createBrowserScrollTool({ computer }));
    tools.set('browser.tabs', withRestartNote(createBrowserTabsTool({ computer })));
    tools.set('browser.new_tab', withRestartNote(createBrowserNewTabTool({ computer })));
    tools.set('browser.navigate', withRestartNote(createBrowserNavigateTool({ computer })));
    tools.set('browser.snapshot', withRestartNote(createBrowserSnapshotTool({ computer })));
    tools.set('browser.get_text', withRestartNote(createBrowserTextTool({ computer })));
    tools.set('browser.click', withRestartNote(createBrowserClickTool({ computer })));
    tools.set('browser.type', withRestartNote(createBrowserTypeTool({ computer })));
    tools.set('browser.fill', withRestartNote(createBrowserFillTool({ computer })));
    tools.set('browser.advance', withRestartNote(createComputerBrowserAdvanceTool({ computer })));
    tools.set('browser.dialog', withRestartNote(createBrowserDialogTool({ computer })));
    tools.set(COMPUTER_BATCH_TOOL, createComputerBatchTool({ computer }));
    tools.set('request_secure_input', withRestartNote(createRequestSecureInputTool({ store, computer })));
    tools.set('request_takeover', withRestartNote(createRequestTakeoverTool({ store, computer })));
    tools.set('shell.run', createComputerShellTool({ computer, environment }));
    registerFileTools(tools, { computer, environment });
    registerProcessTools(tools, { computer, environment });
    tools.set('computer_copy', createComputerCopyTool({ computer, environment }));
    tools.set('computer.install_packages', createInstallPackagesTool({ computer }));
    tools.set('send_file', createSendFileTool({ store, computer, environment, ...(input.channels === undefined ? {} : { channels: input.channels }) }));
    tools.set('artifact_publish', createArtifactPublishTool({ store, computer, environment, ...(input.memory === undefined ? {} : { memory: input.memory }) }));
    tools.set('space_publish', createSpacePublishTool({ store, computer, environment }));
    // After a recovery the next computer tool result tells the model its processes and screens were reset.
    for (const [name, tool] of [...tools].slice(computerToolsFrom)) tools.set(name, withRecreatedNote(tool));
  }

  // Read-only network tools: web_fetch is always there; web_search only with a configured provider.
  tools.set('web_fetch', createWebFetchTool({ ...(input.webFetchDeps === undefined ? {} : { deps: input.webFetchDeps }) }));
  if (input.webSearch !== undefined) tools.set('web_search', createWebSearchTool({ provider: input.webSearch }));

  const voiceTools = new Map<string, Tool>();
  if (input.voice !== undefined) {
    voiceTools.set('discord_voice_join', createVoiceJoinTool(input.voice));
    voiceTools.set('discord_voice_leave', createVoiceLeaveTool(input.voice));
    voiceTools.set('discord_voice_transcript', createVoiceTranscriptTool(input.voice));
  }
  for (const tool of voiceTools.values()) tool.deferLoading = true;
  const hasDiscord = async (agentId: string): Promise<boolean> =>
    (await store.list('channels', { where: { agentId, kind: 'discord' }, limit: 1 })).items.length > 0;
  const pluginVisible = new Map<string, NonNullable<PluginTool['visibleFor']>>();
  // Plugin and MCP tools keep their own text; every other tool's empty description slots are harness units (harness-view.ts).
  const pluginNames = new Set<string>();
  for (const { tool: entry, visibleFor, connectedApp } of input.pluginTools ?? []) {
    // A build gets the registry's lookup; it is read when the built tool runs (`allFor` is defined below), not here.
    const tool: Tool = 'build' in entry ? entry.build({ forAgent: (agentId, options) => allFor(agentId, options) }) : entry;
    if (tools.has(tool.name) || voiceTools.has(tool.name)) throw new Error(`plugin tool "${tool.name}" reuses a built-in tool name`);
    pluginNames.add(tool.name);
    // A host plugin's tool is a connected app for the scope (hidden outside the owner's chat) unless it says otherwise: it has no catalog entry to be shared by.
    if (connectedApp !== false) tool.plugin = true;
    tools.set(tool.name, tool);
    if (visibleFor !== undefined) pluginVisible.set(tool.name, visibleFor);
  }

  /**
   * Every tool the agent can use, hidden ones included: the model sees `presentForModel` of this, the
   * policy and `tool_call` see all of it, so hiding a tool never hides it from the approval rules.
   */
  const allFor = async (agentId: string, options?: { signal?: AbortSignal; turn?: string }): Promise<Tool[]> => {
    // post_to_room stays registered for registry.get (old journal replay and
    // internal callers) but is never model-visible; room delivery goes
    // through send_message targetAgentIds / message_agent via roomDelivery (rooms the user is in only).
    const hiddenPluginTools = new Set<string>();
    for (const [name, visibleFor] of pluginVisible) if (!(await visibleFor(agentId))) hiddenPluginTools.add(name);
    // Mail, Calendar and Reminders on the Mac exist only for an agent the owner allowed on the Mac.
    const macHidden = (await store.get('agents', agentId) as { macAccess?: boolean } | null)?.macAccess !== true;
    const visible = Array.from(tools.values()).filter((tool) => tool.name !== 'post_to_room' && !hiddenPluginTools.has(tool.name) && !(macHidden && (MAC_APP_TOOLS.has(tool.name) || MAC_DESKTOP_TOOL_NAMES.has(tool.name))));
    if (voiceTools.size > 0 && (await hasDiscord(agentId))) visible.push(...voiceTools.values());
    const native = await input.nativeBrowserAvailable?.(agentId) === true;
    if (input.nativeBrowserAvailable && !native) { const legacy = visible.findIndex(tool => tool.name === 'browser.advance'); if (legacy >= 0) visible.splice(legacy, 1); }
    for (let i = 0; i < visible.length; i++) { const tool = visible[i]!; if (GOAL_BROWSER_NAMES.some(name => name === tool.name)) visible[i] = { ...tool, deferLoading: !native }; }
    // The text is read here, in the caller's scope: a turn runs on its session's pinned harness version (BACKEND §11.2).
    const version = currentHarnessVersion();
    const shown = visible.map((tool) => (isBuiltinTool(tool, pluginNames) ? harnessToolView(tool, version) : tool));
    if (mcp === undefined) return shown;
    // Discovery (an MCP initialize handshake or a stdio server start) honors the run's cancellation.
    options?.signal?.throwIfAborted();
    const taken = new Set(shown.map((tool) => tool.name));
    // A connector tool keeps its offer in a group only when its catalog entry is marked sharedRooms (batch 5b, scope.ts).
    const shared = sharedRoomCatalogIds(catalog.list());
    const connected = (await mcpToolsForAgent(mcp, store, agentId, taken, options?.signal, options?.turn)).map((tool) => (tool.origin !== undefined && shared.has(tool.origin.catalogId ?? '') ? { ...tool, sharedRooms: true as const } : tool));
    return [...shown, ...connected];
  };
  // Batch 5b: busy times only, for a group or a stranger's chat; it reads the owner's calendars through the calls their tools make.
  tools.set(CALENDAR_FREE_BUSY, createCalendarFreeBusyTool({ store, ...(computer === undefined ? {} : { computer }), tools: (agentId, signal) => allFor(agentId, { signal }) }));

  // Discovery (the preparer, tool_search, tool_load) offers only what the conversation's scope allows (batch 5b), so a hidden tool
  // does not show up by name in a group or a stranger's chat.
  const discoveryFor = async (agentId: string, signal?: AbortSignal, scope?: ToolScope, turn?: string): Promise<Tool[]> => {
    const all = await allFor(agentId, { ...(signal === undefined ? {} : { signal }), ...(turn === undefined ? {} : { turn }) });
    const offered = all.some(tool => tool.name === 'browser.do' && tool.deferLoading === false)
      // In goal mode the model never sees the per-action browser tools, so a batch of them has nothing to refer to (browser.act fill batches fields).
      ? all.filter(tool => tool.name !== COMPUTER_BATCH_TOOL && (!tool.name.startsWith('browser.') || GOAL_BROWSER_NAMES.some(name => name === tool.name)))
      : all;
    return offeredIn(scope, offered);
  };

  const registry: ToolRegistry = {
    forAgent: allFor,
    close: async () => { await mcp?.close(); },
    ...(input.nativeBrowserAvailable ? { nativeBrowserAvailable: input.nativeBrowserAvailable } : {}),

    get(name: string): Tool | undefined {
      const registered = tools.get(name) ?? voiceTools.get(name);
      if (registered !== undefined || mcp === undefined) return registered;
      return createMcpDispatchTool(name, mcp);
    },
    prepareForModel: createToolPreparer({ all: discoveryFor, ...(input.skills === undefined ? {} : { skills: input.skills }) }),
  };

  // Registered after the registry so the search can reach the same discovery the model does; `allFor`
  // reads the map at call time, so the two proxies are included in their own results (and skipped).
  // skill_read stays readable without a computer (selected skills live on the store row); skill_search
  // is read-only replay-safe discovery over the same bounded catalog. Both are always registered.
  tools.set('skill_read', createSkillReadTool({ ...(computer === undefined ? {} : { computer }), ...(input.skills === undefined ? {} : { skills: input.skills }), ...(input.platformSkills === undefined ? {} : { platformSkills: input.platformSkills }) }));
  tools.set(SKILL_SEARCH, createSkillSearchTool({ ...(input.skills === undefined ? {} : { skills: input.skills }), ...(input.platformSkills === undefined ? {} : { platformSkills: input.platformSkills }) }));
  tools.set(TOOL_SEARCH, createToolSearchTool({
    all: discoveryFor,
    visible: async (agentId, signal, scope, turn) => new Set(presentForModel(offeredIn(scope, await allFor(agentId, { ...(signal === undefined ? {} : { signal }), ...(turn === undefined ? {} : { turn }) }))).map((tool) => tool.name)),
  }));
  tools.set(TOOL_LOAD, createToolLoadTool({
    all: discoveryFor,
    visible: async (agentId, signal, scope, turn) => new Set(presentForModel(offeredIn(scope, await allFor(agentId, { ...(signal === undefined ? {} : { signal }), ...(turn === undefined ? {} : { turn }) }))).map((tool) => tool.name)),
  }));
  tools.set(TOOL_CALL, createToolCallTool());
  // Default compact view: only CORE_TOOL_NAMES stay model-visible. Every other
  // production builtin (MCP tools default to deferred in the view itself) carries
  // deferLoading, so custom test stubs without a marker stay visible.
  for (const [name, tool] of tools) {
    if (CORE_TOOL_NAMES.indexOf(name) === -1 && tool.mcp !== true) tool.deferLoading = true;
  }
  // What the model is shown declares every optional string as nullable ("no value" has a legal spelling); the harness leaves
  // an optional "", blank or null out before the tool runs (toolArguments.ts). Connected-app (MCP) schemas are the server's own.
  for (const tool of [...tools.values(), ...voiceTools.values()]) if (tool.mcp !== true) tool.parameters = publicParameters(tool.parameters);
  checkToolUnits([...tools.values(), ...voiceTools.values()], pluginNames);
  return registry;
}

/**
 * The sandbox-bound file tools, registered as one small unit so a later integrator (MCP resolver,
 * per-owner tool cache, policy hooks) can own or extend the file seam in one place.
 */
function registerFileTools(
  tools: Map<string, Tool>,
  opts: { computer: ComputerClientProvider; environment: ComputerEnvironmentSource },
): void {
  tools.set('files.read', createFileReadTool(opts));
  tools.set('files.write', createFileWriteTool(opts));
  tools.set('files.edit', createFileEditTool(opts));
  tools.set('files.search', createFileSearchTool(opts));
}

/** The async process tools (start/poll/input/stop), owned as one small unit like the file seam. */
function registerProcessTools(
  tools: Map<string, Tool>,
  opts: { computer: ComputerClientProvider; environment: ComputerEnvironmentSource },
): void {
  tools.set('shell.start', createShellStartTool(opts));
  tools.set('shell.poll', createShellPollTool(opts));
  tools.set('shell.input', createShellInputTool(opts));
  tools.set('shell.stop', createShellStopTool(opts));
}

export type { Tool, ToolRegistry };
export { noteComputerRecreated, noteControlChanged } from './computer/shared.js';
export { browserInputSchema, browserResultSchema, ComputerError, computerEnvironmentSchema, parseEnvironment } from './computer/contract.js';
export type {
  BrowserInput,
  BrowserResult,
  ComputerClient,
  ComputerCopyResult,
  ComputerEnvironment,
  ComputerErrorCode,
  ComputerTarget,
  FileContent,
  FileWriteRequest,
  FileWriteResult,
  MouseButton,
  NavigateResult,
  Point,
  ProcessOutput,
  ProcessReadInput,
  ProcessSnapshot,
  ProcessStartInput,
  ProcessState,
  ProcessStopInput,
  ProcessStopResult,
  ProcessWriteInput,
  ProcessWriteResult,
  RecordAudioInput,
  RecordAudioResult,
  Screenshot,
  ScrollInput,
  ShellInput,
  ShellOutput,
} from './computer/contract.js';
export type { ComputerClientProvider, ComputerEnvironmentSource } from './computer/client.js';

/**
 * The Apps view (BACKEND 10.18): what `GET /v1/apps` and `GET /v1/apps/:id` answer. An app is a chat platform, an entry of the connector
 * catalog, a web app read through the agent's computer, or one custom MCP server; an installation is the row that already holds its credentials (a `connections` row, a
 * `channelInstallations` row, or an agent's own bot in `channels`), so nothing here is stored twice and nothing can drift. Who may use
 * a work or custom app is the `agentApps` row (no row: everyone, actions asking first); who is enabled in a chat workspace is the
 * agent's `channels` row on that installation.
 */
import type { ChannelInstallation, ChannelRow, Store } from '@agent-desktop/contracts';
import {
  chatCapabilities,
  type ActionsPolicy,
  type Agent,
  type App,
  type AppCapability,
  type AppDetail,
  type AppInstallation,
  type AppPending,
  type AppWorkspaceAgent,
  type Connection,
} from '@agent-desktop/public-contracts';
import type { AppCatalogRow } from 'juno-agent/contracts';
import {
  capabilityKind,
  entryClientAvailable,
  missingDefaultConnections,
  platformKeyConfigured,
  withoutCoveredComposio,
  type CatalogEntry,
  type McpManager,
} from 'juno-agent/modules/mcp/index';
import { connectionInstallation, DEFAULT_AGENT_APP, type AgentAppSetting } from 'juno-agent/modules/apps/agent-apps';
import { appAuthOf, rowEntry, userConfigList, type CatalogReader } from 'juno-agent/modules/apps/catalog';
import { FREE_PLAN_MESSAGE } from '../channels/connect.js';
import { PENDING_KIND } from '../channels/pending.js';
import type { ChannelRegistry } from '../channels/registry.js';
import { docOwnerId, isAgentVisible, listAll } from '../routes/relationships.js';

export interface AppsViewDeps {
  store: Store;
  channels: ChannelRegistry;
  /** The app catalog table: what the page lists. The chat registry says which chat platforms this deployment can carry. */
  catalog: CatalogReader;
  /** Lists an app's tools for its capability list; absent leaves the list empty. */
  mcp?: McpManager;
  env?: Record<string, string | undefined>;
}

/** What the owner has, read once: the rows every app of the view is built from. */
interface Facts {
  ownerId: string;
  agents: Agent[];
  connections: Connection[];
  settings: ReadonlyMap<string, AgentAppSetting>;
  channelRows: ChannelRow[];
  installations: ChannelInstallation[];
  pending: ChannelRow[];
}

const settingKey = (agentId: string, appId: string): string => agentId + ':' + appId;
const isConnectionRow = (doc: { kind?: unknown }): boolean => doc.kind === 'mcp';

async function gather(deps: AppsViewDeps, ownerId: string): Promise<Facts> {
  const agents = (await listAll(deps.store, 'agents')).items.filter((agent) => isAgentVisible(agent, ownerId));
  const connections: Connection[] = (await listAll(deps.store, 'connections')).items.filter((row) => docOwnerId(row) === ownerId && isConnectionRow(row));
  // The keyless servers are connected by default (juno-agent mcp/platform-keys.ts): written on first sight, as the agent's own tool list does.
  for (const doc of missingDefaultConnections(ownerId, connections, deps.env ?? process.env).filter((candidate) => candidate.catalogId !== undefined && deps.catalog.list().some((entry) => entry.id === candidate.catalogId))) {
    connections.push(await deps.store.put('connections', doc));
  }
  const rows = (await listAll(deps.store, 'agentApps')).items.filter((row) => docOwnerId(row) === ownerId);
  const channelRows = (await listAll(deps.store, 'channels')).items.filter((row) => docOwnerId(row) === ownerId);
  return {
    ownerId,
    agents,
    connections,
    settings: new Map(rows.map((row) => [settingKey(row.agentId, row.appId), { enabled: row.enabled, actionsPolicy: row.actionsPolicy }] as const)),
    channelRows: channelRows.filter((row) => row.kind !== PENDING_KIND),
    installations: (await listAll(deps.store, 'channelInstallations')).items.filter((row) => docOwnerId(row) === ownerId),
    pending: channelRows.filter((row) => row.kind === PENDING_KIND),
  };
}

/** The agents of the owner that may use a work or custom app, with the policy each has for it (nobody when the app is not added). */
function enabledAgents(facts: Facts, appId: string, added: boolean): Array<{ agentId: string; actionsPolicy: ActionsPolicy }> {
  if (!added) return [];
  return facts.agents.flatMap((agent) => {
    const setting = facts.settings.get(settingKey(agent.id, appId)) ?? DEFAULT_AGENT_APP;
    return setting.enabled ? [{ agentId: agent.id, actionsPolicy: setting.actionsPolicy }] : [];
  });
}

function available(entry: CatalogEntry, env: Record<string, string | undefined>): boolean {
  if (entry.installBlock !== undefined) return false;
  if (entry.platformKey === true && !platformKeyConfigured(entry.id, env)) return false;
  return entryClientAvailable(entry, env);
}

/** The package details every kind of app shows: version, who makes it and where to read about it. */
function packageInfo(row: AppCatalogRow): Pick<App, 'version' | 'developerName' | 'brandColor' | 'websiteUrl' | 'privacyPolicyUrl' | 'termsOfServiceUrl'> {
  const face = row.interface;
  return {
    version: row.version,
    ...(face.developerName === undefined ? {} : { developerName: face.developerName }),
    ...(face.brandColor === undefined ? {} : { brandColor: face.brandColor }),
    ...(face.websiteUrl === undefined ? {} : { websiteUrl: face.websiteUrl }),
    ...(face.privacyPolicyUrl === undefined ? {} : { privacyPolicyUrl: face.privacyPolicyUrl }),
    ...(face.termsOfServiceUrl === undefined ? {} : { termsOfServiceUrl: face.termsOfServiceUrl }),
  };
}

function workApp(deps: AppsViewDeps, facts: Facts, row: AppCatalogRow, entry: CatalogEntry): App | undefined {
  const found = facts.connections.filter((connection) => connection.catalogId === entry.id).flatMap((connection) => connectionInstallation(connection, entry.id, entry.name) ?? []);
  // Two accounts of one app that have no label of their own are told apart by their order.
  const installations = found.length < 2 ? found : found.map((installation, index) => (found.some((other) => other !== installation && other.label === installation.label) ? { ...installation, label: installation.label + ' (' + String(index + 1) + ')' } : installation));
  // A hidden app is not offered any more; the owners who added it still see it.
  if (row.status === 'hidden' && installations.length === 0) return undefined;
  return {
    id: entry.id,
    name: entry.name,
    category: 'work',
    source: entry.source === 'composio' ? 'composio' : 'official',
    ...(row.group === undefined ? {} : { group: row.group }),
    icon: entry.icon,
    ...listing(row),
    available: available(entry, deps.env ?? process.env),
    userConfig: userConfigList(row.userConfig),
    ...packageInfo(row),
    grants: { chatRead: true, actions: entry.readOnly !== true },
    installations,
    enabledAgents: enabledAgents(facts, entry.id, installations.length > 0),
  };
}

/** A custom MCP server is an app of its own, named by its connection. One the owner disconnected is gone from the list (its row stays). */
function customApps(facts: Facts): App[] {
  return facts.connections.filter((connection) => connection.catalogId === undefined && connection.enabled !== false).map((connection) => {
    // A remote server the owner has not signed in to yet is listed too, so it can be finished or removed.
    const installation = connectionInstallation(connection, connection.id, connection.name) ?? { id: connection.id, appId: connection.id, label: connection.name, status: 'error' as const, agents: [] };
    const where = connection.endpoint === undefined || !/^https?:/.test(connection.endpoint) ? 'A server run on the agent\'s computer.' : connection.endpoint;
    return {
      id: connection.id,
      name: connection.name,
      category: 'custom' as const,
      source: 'custom' as const,
      icon: 'custom',
      blurb: 'A server you added.',
      description: where,
      tryAsking: [],
      auth: 'oauth' as const,
      available: true,
      userConfig: [],
      version: 1,
      grants: { chatRead: true, actions: true },
      installations: [installation],
      enabledAgents: enabledAgents(facts, connection.id, true),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function workspaceAgent(row: ChannelRow): AppWorkspaceAgent {
  return {
    agentId: row.agentId,
    handle: row.handle ?? null,
    ...(row.handleStatus === undefined ? {} : { handleStatus: row.handleStatus }),
    ...(row.handleStatus === 'needs_paid_plan' ? { statusMessage: FREE_PLAN_MESSAGE } : {}),
  };
}

/** `invalid_token`: the platform refused the credential; `pending_install`: a Slack app made but not installed yet. */
function ownBotStatus(row: ChannelRow): AppInstallation['status'] {
  if (row.status === 'invalid_token') return 'expired';
  return row.status === 'pending_install' ? 'error' : 'connected';
}

/** An own bot's name: Telegram's channel id is its @username; the others carry the name found at connect or by the boot backfill (`apps/labels.ts`). A raw platform id is never shown. */
function ownBotLabel(row: ChannelRow, platform: string): string {
  if (row.kind === 'telegram') return '@' + row.channelId;
  return row.accountName ?? platform + ' bot';
}

/** The installation's name (Slack team name, Discord server name), kept on the row; until the platform has told us, "Discord server" / "Slack workspace". */
function workspaceLabel(installation: ChannelInstallation, platform: string): string {
  return installation.label ?? platform + (installation.kind === 'slack' ? ' workspace' : ' server');
}

/** The installations of one chat app: each workspace the Juno bot is in, and each bot an agent holds of its own. */
export function chatInstallations(facts: Pick<Facts, 'installations' | 'channelRows'>, kind: string, name: string, appId: string = kind): AppInstallation[] {
  const shared = facts.installations.filter((installation) => installation.kind === kind).map((installation): AppInstallation => ({
    id: installation.id,
    appId,
    label: workspaceLabel(installation, name),
    status: 'connected',
    connectedAt: installation.createdAt,
    bound: installation.installedBy !== undefined,
    agents: facts.channelRows.filter((row) => row.kind === kind && row.installationId === installation.id).map(workspaceAgent),
  }));
  const own = facts.channelRows.filter((row) => row.kind === kind && row.installationId === undefined).map((row): AppInstallation => ({
    id: row.id,
    appId,
    label: ownBotLabel(row, name),
    status: ownBotStatus(row),
    connectedAt: row.createdAt,
    agentId: row.agentId,
    bound: row.ownerExternalId !== undefined,
    agents: [{ agentId: row.agentId, handle: null }],
  }));
  return [...shared, ...own];
}

/** The text every kind of app carries from its catalog row. */
function listing(row: AppCatalogRow): Pick<App, 'blurb' | 'description' | 'tryAsking' | 'auth'> {
  const face = row.interface;
  return { blurb: face.shortDescription, description: face.longDescription, tryAsking: face.defaultPrompts, auth: appAuthOf(row) };
}

/** A chat app's platform is the plugin its package binds it to; one the deployment does not run is not listed. */
function chatApp(deps: AppsViewDeps, facts: Facts, row: AppCatalogRow): App | undefined {
  const kind = row.binding?.plugin ?? row.appId;
  const registration = deps.channels.get(kind);
  if (registration === undefined) return undefined;
  const installations = chatInstallations(facts, kind, row.interface.displayName, row.appId);
  if (row.status === 'hidden' && installations.length === 0) return undefined;
  const agentIds = [...new Set(installations.flatMap((installation) => installation.agents.map((agent) => agent.agentId)))];
  return {
    id: row.appId,
    name: row.interface.displayName,
    category: 'chat',
    source: 'official',
    icon: row.interface.icon,
    ...listing(row),
    available: true,
    userConfig: [],
    ...packageInfo(row),
    ...(registration.workspace === undefined ? {} : { workspaceInstall: registration.workspace.configured() }),
    grants: { chatRead: true, actions: false },
    installations,
    enabledAgents: agentIds.map((agentId) => ({ agentId })),
  };
}

/** A web app the agent reads through its computer (`binding.login` none or sandbox): adding it only turns it on; a sign-in is asked for when a read needs one. Without `login` it is a sign-in slot that cannot be added yet. */
export const isReachWebApp = (row: Pick<AppCatalogRow, 'category' | 'binding'>): boolean => row.category === 'web' && row.binding?.login !== undefined;

/**
 * A web app is read through the agent's computer (BACKEND 10.18): no MCP server, no tools, only its how-to skill. Its installation is a
 * `connections` row with the app's id as `catalogId` and no endpoint, so "added", "turned on for this agent" and the skill gate are the same
 * rule as for a work app; the MCP manager never connects it because the connector catalog has no entry for it.
 */
function webApp(facts: Facts, row: AppCatalogRow): App | undefined {
  const installations = facts.connections.filter((connection) => connection.catalogId === row.appId).flatMap((connection) => connectionInstallation(connection, row.appId, row.interface.displayName) ?? []);
  // A hidden app is not offered any more; the owners who added it still see it.
  if (row.status === 'hidden' && installations.length === 0) return undefined;
  return {
    id: row.appId, name: row.interface.displayName, category: 'web', source: 'official', icon: row.interface.icon, ...listing(row), userConfig: [], ...packageInfo(row),
    available: isReachWebApp(row), grants: { chatRead: true, actions: false }, installations, enabledAgents: enabledAgents(facts, row.appId, installations.length > 0),
  };
}

/** The page's order is the catalog's: the rows as the admin keeps them. A retired row is gone from the page and from every agent's tools. */
function allApps(deps: AppsViewDeps, facts: Facts): App[] {
  // A Composio row is offered only where this deployment can connect it and no first-party app covers the same toolkit.
  const env = deps.env ?? process.env;
  const shown = new Set(withoutCoveredComposio(deps.catalog.rows().flatMap((row) => (row.status === 'retired' ? [] : rowEntry(row) ?? [])), env).map((entry) => entry.id));
  const rows = deps.catalog.rows().filter((row) => row.source === undefined || shown.has(row.appId));
  return [
    ...rows.flatMap((row): App[] => {
      if (row.status === 'retired') return [];
      if (row.category === 'web') {
        const web = webApp(facts, row);
        return web === undefined ? [] : [web];
      }
      const entry = rowEntry(row);
      const app = row.category === 'chat' ? chatApp(deps, facts, row) : entry === undefined ? undefined : workApp(deps, facts, row, entry);
      return app === undefined ? [] : [app];
    }),
    ...customApps(facts),
  ];
}

/** Every app this deployment offers, with what the owner has added and which agents may use each. */
export async function listApps(deps: AppsViewDeps, ownerId: string): Promise<App[]> {
  return allApps(deps, await gather(deps, ownerId));
}

function pendingView(row: ChannelRow): AppPending | undefined {
  const data = row.pending;
  if (data === undefined) return undefined;
  const openUrl = data.installUrl ?? data.createUrl ?? data.verificationUrl;
  const overdue = data.state === 'pending' && Date.parse(data.expiresAt) <= Date.now();
  return {
    id: row.channelId,
    status: overdue ? 'expired' : data.state,
    expiresAt: data.expiresAt,
    ...(openUrl === undefined ? {} : { openUrl }),
    ...(data.error === undefined ? {} : { error: data.error }),
    agentId: row.agentId,
  };
}

/**
 * What a chat app can do, from the chat capability table. Hearing and reading are `read`; putting something into the chat that was not
 * asked for as an answer (a file, a reaction, a card with buttons) is `change`. Replying in the conversation where the agent was
 * addressed is the chat itself, neither read nor change policy, but the contract's `kind` has only those two values, so it is listed as
 * `read` (it is always on and belongs to "Chat & read").
 */
function chatCapabilityList(kind: string): AppCapability[] {
  const caps = chatCapabilities(kind);
  return [
    { name: 'reply', title: 'Reply', kind: 'read' },
    ...(caps.history.window || caps.history.onDemand ? [{ name: 'history', title: 'Read earlier messages of a chat', kind: 'read' as const }] : []),
    ...(caps.files.read ? [{ name: 'files_receive', title: 'Receive files', kind: 'read' as const }] : []),
    ...(caps.files.send ? [{ name: 'files_send', title: 'Send files', kind: 'change' as const }] : []),
    ...(caps.reactions.mode === 'none' ? [] : [{ name: 'react', title: 'React to messages', kind: 'change' as const }]),
    ...(caps.ui.choices ? [{ name: 'buttons', title: 'Show buttons to answer', kind: 'change' as const }] : []),
  ];
}

/** The tools of the app's first signed-in account, labelled read or change; empty when none is signed in or the server cannot be reached. */
async function toolCapabilities(deps: AppsViewDeps, app: App, ownerId: string): Promise<AppCapability[]> {
  const live = app.installations.find((installation) => installation.status === 'connected');
  if (live === undefined || deps.mcp === undefined) return [];
  try {
    const tools = await deps.mcp.listTools({ ownerId, store: deps.store, connectionId: live.id, signal: AbortSignal.timeout(8_000) });
    return tools.map((tool) => ({ name: tool.name, title: tool.title, kind: capabilityKind(tool.access), ...(tool.needsReview ? { needsReview: true } : {}) }));
  } catch {
    return [];
  }
}

/** One app with its capability list and the installs the platform is still finishing; undefined when there is no such app here. */
export async function appDetail(deps: AppsViewDeps, ownerId: string, appId: string): Promise<AppDetail | undefined> {
  const facts = await gather(deps, ownerId);
  const app = allApps(deps, facts).find((candidate) => candidate.id === appId);
  if (app === undefined) return undefined;
  const row = deps.catalog.rows().find((candidate) => candidate.appId === appId);
  const kind = row?.binding?.plugin ?? appId;
  const capabilities = app.category === 'chat' ? chatCapabilityList(kind) : app.category === 'web' ? [] : await toolCapabilities(deps, app, ownerId);
  const pending = app.category === 'chat' ? facts.pending.filter((candidate) => candidate.pending?.platform === kind).flatMap((candidate) => pendingView(candidate) ?? []) : [];
  const skills = (row?.skills ?? []).map((skill) => ({ name: skill.name, description: skill.description, onboarding: skill.name === row?.onboardingSkill }));
  return { ...app, capabilities, pending, skills };
}

export { pendingView, gather as gatherAppFacts };

/**
 * Apps, as the agent and the gate see them (BACKEND 10.18). An app is a connector catalog entry (id `gmail`) or one custom MCP server
 * (its connection id); the owner adds it once and turns it on per agent. What an agent may do with it is one row per agent and app
 * (`agentApps`): enabled or not, and the policy for the app's changing tools (ask first, allow, off). No row means the default,
 * enabled with actions asking first, so a new agent or a new app works at once and only a change is stored.
 */
import type { ActionsPolicy, AppInstallation, AppProblem, Connection } from '@agent-desktop/public-contracts';
import type { AgentAppRow, Store } from '../../contracts/index.js';
import { listAll } from '../memory/util.js';

export interface AgentAppSetting {
  enabled: boolean;
  actionsPolicy: ActionsPolicy;
}

export const DEFAULT_AGENT_APP: AgentAppSetting = { enabled: true, actionsPolicy: 'ask' };

export const agentAppRowId = (agentId: string, appId: string): string => agentId + ':' + appId;

/** The app a connection belongs to: its catalog entry, else itself (a custom server is one app of its own). */
export const appIdOfConnection = (connection: Pick<Connection, 'id' | 'catalogId'>): string => connection.catalogId ?? connection.id;

/** How a connection stands: connected, expired (it worked and the sign-in is now rejected), error (it never worked), or undefined (not added). */
export function connectionStanding(connection: Pick<Connection, 'status' | 'enabled' | 'connectedAt'>): 'connected' | 'expired' | 'error' | undefined {
  if (connection.enabled === false) return undefined;
  if (connection.status === 'connected') return 'connected';
  if (connection.status === 'error') return connection.connectedAt === undefined ? 'error' : 'expired';
  return undefined;
}

/**
 * One connection as the account an app is added with, or undefined when it is not added (never signed in, or disconnected). `label`
 * is the account when the connection knows it, else the app's own name. A custom stdio server starts when an agent first uses it, so
 * it counts as connected until a session says otherwise.
 */
export function connectionInstallation(connection: Connection, appId: string, appName: string): AppInstallation | undefined {
  const standing = connectionStanding(connection) ?? (connection.enabled !== false && Reflect.get(connection, 'transport') === 'stdio' ? 'connected' : undefined);
  if (standing === undefined) return undefined;
  return {
    id: connection.id,
    appId,
    label: connection.account ?? appName,
    status: standing,
    ...(connection.connectedAt === undefined ? {} : { connectedAt: connection.connectedAt }),
    agents: [],
  };
}

/** The agent's stored settings by app id; an app with no row is not in the map (read it with `settingFor`). */
export async function agentAppSettings(store: Store, agentId: string): Promise<ReadonlyMap<string, AgentAppSetting>> {
  const rows = await listAll(store, 'agentApps', { where: { agentId } });
  return new Map(rows.map((row) => [row.appId, { enabled: row.enabled, actionsPolicy: row.actionsPolicy }] as const));
}

export const settingFor = (settings: ReadonlyMap<string, AgentAppSetting>, appId: string): AgentAppSetting => settings.get(appId) ?? DEFAULT_AGENT_APP;

/** Writes one agent's setting for one app; a field left out keeps what the agent has now (or the default). */
export async function setAgentApp(store: Store, input: { ownerId: string; agentId: string; appId: string; enabled?: boolean; actionsPolicy?: ActionsPolicy }): Promise<AgentAppRow> {
  const current = settingFor(await agentAppSettings(store, input.agentId), input.appId);
  const row: AgentAppRow = {
    id: agentAppRowId(input.agentId, input.appId),
    ownerId: input.ownerId,
    agentId: input.agentId,
    appId: input.appId,
    enabled: input.enabled ?? current.enabled,
    actionsPolicy: input.actionsPolicy ?? current.actionsPolicy,
    updatedAt: new Date().toISOString(),
  };
  return store.put('agentApps', row);
}

/** The apps this agent can use right now (added, signed in and turned on for it), by app id with the name the owner sees. */
export function usableApps(connections: readonly Connection[], settings: ReadonlyMap<string, AgentAppSetting>): Map<string, string> {
  const found = new Map<string, string>();
  for (const connection of connections) {
    const appId = appIdOfConnection(connection);
    if (connectionStanding(connection) === 'connected' && settingFor(settings, appId).enabled && !found.has(appId)) found.set(appId, connection.name);
  }
  return found;
}

/** Why each listed app is not usable by the agent, for the Connect card (it tells the owner whether to add it, turn it on or sign in again); `mac` has no entry. */
export function problemsOf(appIds: readonly string[], problemOf: ((appId: string) => AppProblem | undefined) | undefined): Record<string, AppProblem> | undefined {
  const found = appIds.flatMap((id) => { const problem = id === 'mac' ? undefined : problemOf?.(id); return problem === undefined ? [] : [[id, problem] as const]; });
  return found.length === 0 ? undefined : Object.fromEntries(found);
}

/** The access state of one app for one agent (BACKEND 10.18.1). `scope` names the permission a `scope_missing` sign-in lacks, when the provider said. */
export interface AppAccess {
  appId: string;
  state: 'ready' | AppProblem;
  scope?: string;
}

/**
 * The one place that says whether an agent can use an app and, when not, why. Account first (not added, then needs a new sign-in, as
 * the provider's last answer shows), then the agent's switch (`not_enabled`), then, for a call that changes things (`tool: 'action'`),
 * the agent's Actions policy (`not_granted`). A usable account anywhere makes the account part ready.
 */
export function appAccess(connections: readonly Connection[], settings: ReadonlyMap<string, AgentAppSetting>, appId: string, tool?: 'read' | 'action'): AppAccess {
  const live = connections.filter((connection) => appIdOfConnection(connection) === appId && connectionStanding(connection) !== undefined);
  if (live.length === 0) return { appId, state: 'not_added' };
  const setting = settingFor(settings, appId);
  if (!setting.enabled) return { appId, state: 'not_enabled' };
  if (live.some((connection) => connectionStanding(connection) === 'connected')) {
    return tool === 'action' && setting.actionsPolicy === 'off' ? { appId, state: 'not_granted' } : { appId, state: 'ready' };
  }
  // A 403 insufficient_scope left the permission on the row (mcp/manager.ts); an empty scope still means the sign-in lacks one.
  const lacking = live.map((connection) => Reflect.get(connection, 'needsScope')).find((scope): scope is string => typeof scope === 'string');
  if (lacking !== undefined) return { appId, state: 'scope_missing', ...(lacking === '' ? {} : { scope: lacking }) };
  return { appId, state: live.some((connection) => connectionStanding(connection) === 'expired') ? 'expired' : 'needs_reconnect' };
}

/** Why the agent cannot use an app, or undefined when it can (the Connect card's `problems`). */
export function appProblem(connections: readonly Connection[], settings: ReadonlyMap<string, AgentAppSetting>, appId: string): AppProblem | undefined {
  const { state } = appAccess(connections, settings, appId);
  return state === 'ready' ? undefined : state;
}

/**
 * The one sentence the model gets when a call is refused, from the access state: what is wrong, who can fix it and that retrying will not
 * help. `name` is what the owner calls the app; `tool` the tool that was refused; `cardable` is false for a custom server, which has no
 * catalog id for a Connect card (the owner fixes it on the Apps page). Undefined when the app is ready.
 */
export function accessSentence(access: AppAccess, name: string, tool?: string, cardable = true): string | undefined {
  const card = cardable ? `connect_request with connectors ["${access.appId}"] puts a button for it in the chat` : 'they do it on the Apps page';
  switch (access.state) {
    case 'ready': return undefined;
    case 'not_added': return `${name} is not added yet. Ask the person to add it; ${card}. Do not retry.`;
    case 'not_enabled': return `${name} is turned off for you. Ask the person to turn it on for you; ${card}. Do not retry.`;
    case 'needs_reconnect': return `${name} never finished connecting. Ask the person to reconnect ${name}; ${card}. Do not retry until they have.`;
    case 'expired': return `${name}'s sign-in expired or was withdrawn. Ask the person to reconnect ${name}; ${card}. Do not retry until they have.`;
    case 'scope_missing': return `${name} is connected, but its sign-in lacks a permission${access.scope === undefined ? '' : ' (' + access.scope + ')'}. Ask the person to reconnect ${name} and allow it; ${card}. Do not retry until they have.`;
    case 'not_granted': return `${tool ?? 'This'} changes things in ${name}, and Actions is off for you there. Ask the person to switch Actions on for you in ${name} on the Apps page. Do not retry.`;
  }
}

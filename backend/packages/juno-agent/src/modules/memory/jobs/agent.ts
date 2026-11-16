/** The agent the memory jobs act as: it names the computer to write to and the model to call. */
import { settingsIdFor, type Agent } from '@agent-desktop/public-contracts';
import type { Store } from '../../../contracts/index.js';
import { channelOrigin } from '../../../execution/conversation-activity.js';
import { docOwner } from '../../../execution/execution-owner.js';
import { listAll } from '../util.js';

/** The agents the owner created, oldest first. */
export async function ownerAgents(store: Store, ownerId: string): Promise<Agent[]> {
  return (await listAll(store, 'agents')).filter((agent) => docOwner(agent) === ownerId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * The agent the owner talks to most recently in the app: the one in the in-app direct chat with the newest message. The order agents
 * were created in says nothing about who the owner uses (a test agent made first would win). Undefined when no agent has such a chat.
 */
async function mostRecentlyUsed(store: Store, ownerId: string, agents: readonly Agent[]): Promise<Agent | undefined> {
  const ids = new Set(agents.map((agent) => agent.id));
  const chats = (await listAll(store, 'conversations')).filter((chat) => chat.kind === 'direct' && docOwner(chat) === ownerId && channelOrigin(chat) === undefined && ids.has(chat.agentIds[0] ?? ''));
  const newest = chats.sort((a, b) => b.lastItemAt.localeCompare(a.lastItemAt) || a.id.localeCompare(b.id))[0];
  return agents.find((agent) => agent.id === newest?.agentIds[0]);
}

/**
 * The default agent of the settings if it is the owner's, else the agent with the most recent in-app direct chat, else (nobody has talked
 * to any agent in the app) the oldest. Undefined when they have no agent. `log` is told which rule picked it.
 */
export async function jobAgent(store: Store, ownerId: string, log?: (fields: Record<string, unknown>, message: string) => void): Promise<{ agent: Agent; agents: Agent[] } | undefined> {
  const agents = await ownerAgents(store, ownerId);
  const settings = await store.get('settings', settingsIdFor(ownerId));
  const wanted = agents.find((candidate) => candidate.id === settings?.general.defaultAgentId);
  const recent = wanted === undefined ? await mostRecentlyUsed(store, ownerId, agents) : undefined;
  const agent = wanted ?? recent ?? agents[0];
  if (agent !== undefined && agents.length > 1) log?.({ ownerId, agentId: agent.id }, 'job agent picked by ' + (wanted !== undefined ? 'the default agent setting' : recent !== undefined ? 'the most recent in-app chat' : 'creation order: no in-app chat with any agent'));
  return agent === undefined ? undefined : { agent, agents };
}

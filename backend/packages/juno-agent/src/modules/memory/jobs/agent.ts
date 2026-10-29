/** The agent the memory jobs act as: it names the computer to write to and the model to call. */
import { settingsIdFor, type Agent } from '@agent-desktop/public-contracts';
import type { Store } from '../../../contracts/index.js';
import { docOwner } from '../../../execution/execution-owner.js';
import { listAll } from '../util.js';

/** The agents the owner created, oldest first. */
export async function ownerAgents(store: Store, ownerId: string): Promise<Agent[]> {
  return (await listAll(store, 'agents')).filter((agent) => docOwner(agent) === ownerId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** The default agent of the settings if it is the owner's, else their oldest agent; undefined when they have none. */
export async function jobAgent(store: Store, ownerId: string): Promise<{ agent: Agent; agents: Agent[] } | undefined> {
  const agents = await ownerAgents(store, ownerId);
  const settings = await store.get('settings', settingsIdFor(ownerId));
  const wanted = settings?.general.defaultAgentId;
  const agent = agents.find((candidate) => candidate.id === wanted) ?? agents[0];
  return agent === undefined ? undefined : { agent, agents };
}

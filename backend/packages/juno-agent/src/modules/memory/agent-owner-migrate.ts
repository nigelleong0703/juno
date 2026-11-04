/**
 * One-time move to per-agent memory (BACKEND 5.4a, 2026-11-02): until now every memory item was shared by the owner's agents unless it
 * sat in an agent's section of a person's page. An item now belongs to the agent that learned it (`agent_id`), and `agent_id` null is
 * the shared core. Provenance decides: a note names its author (`said_by_agent_id`); a claim from the hourly digest rests on a message
 * in a conversation, and a conversation with exactly one agent says which agent learned it. An item with neither (migrated lines, the
 * owner's hand edits in the app, a group chat with several agents, an agent that no longer exists) stays shared, so nothing is lost.
 * A marker row makes later boots skip all of it. Pass the raw (unscoped) store.
 */
import type { Store } from '../../contracts/index.js';
import { docOwner } from '../../execution/execution-owner.js';
import { getRow, newRow, putRow } from '../home/mirror.js';
import type { HomeDeps } from '../home/service.js';
import type { MemoryGraph } from './graph.js';
import { jobAgent, ownerAgents } from './jobs/agent.js';
import { renderViews } from './views.js';
import { listAll } from './util.js';

export const MARKER = '__migrations/memory-per-agent-v1';

export interface AgentOwnerMigration { skipped: boolean; owners: number; byNote: number; byConversation: number; keptShared: number }

export async function migrateAgentMemory(deps: HomeDeps & { memory: MemoryGraph }): Promise<AgentOwnerMigration> {
  const { store, memory } = deps;
  const result: AgentOwnerMigration = { skipped: false, owners: 0, byNote: 0, byConversation: 0, keptShared: 0 };
  if ((await getRow(store, 'system', MARKER)) !== null) return { ...result, skipped: true };
  const owners = [...new Set((await listAll(store, 'agents')).map((agent) => docOwner(agent)).filter((id): id is string => typeof id === 'string' && id !== ''))];
  for (const ownerId of owners) {
    const mine = new Set((await ownerAgents(store, ownerId)).map((agent) => agent.id));
    const claims = new Map((await listAll(store, 'memoryClaims')).filter((claim) => claim.ownerId === ownerId).map((claim) => [claim.id, claim]));
    for (const item of await memory.items.listItems(ownerId)) {
      if (item.agentId !== null) continue;
      let agentId: string | undefined;
      let how: 'byNote' | 'byConversation' = 'byNote';
      if (item.saidByAgentId !== null && mine.has(item.saidByAgentId)) agentId = item.saidByAgentId;
      else {
        const first = item.claimId === null ? undefined : claims.get(item.claimId)?.evidence[0];
        const source = first === undefined ? null : await store.get('items', first.itemId);
        const conversation = source === null ? null : await store.get('conversations', source.conversationId);
        const only = conversation?.agentIds.length === 1 ? conversation.agentIds[0] : undefined;
        if (only !== undefined && mine.has(only)) {
          agentId = only;
          how = 'byConversation';
        }
      }
      if (agentId === undefined) {
        result.keptShared += 1;
        continue;
      }
      await memory.items.updateItem(ownerId, item.id, { agentId });
      result[how] += 1;
    }
    result.owners += 1;
  }
  // The views are rendered after the marker is written, like the other memory migrations: a run that stops later must not be repeated.
  await putRow(store, newRow('system', MARKER, '', 'platform', new Date().toISOString()));
  for (const ownerId of owners) {
    const agent = await jobAgent(store, ownerId);
    if (agent !== undefined) await renderViews(deps, { ownerId, agentId: agent.agent.id });
  }
  return result;
}

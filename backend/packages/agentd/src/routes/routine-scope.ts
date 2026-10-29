/**
 * Routine target-scope helpers.
 *
 * A routine must run as the (owner-mutable) agent it names and deliver into a chat the owner can
 * see. These helpers resolve that binding and refuse missing/foreign agents and foreign delivery
 * chats before any write or timer arm, so create and PATCH cannot rebind a routine across owners.
 */
import type { Store } from '@agent-desktop/contracts';
import type { Agent, Delivery } from '@agent-desktop/public-contracts';
import { canMutateAgent, isConversationVisible, relationshipError, type RelationshipError } from './relationships.js';

export interface RoutineTarget {
  agent: Agent;
}

/** Resolve the agent the routine runs as. The caller must be able to mutate the agent. */
export async function resolveRoutineTarget(
  store: Store,
  ownerId: string,
  agentId: string,
): Promise<RoutineTarget | RelationshipError> {
  const agent = await store.get('agents', agentId);
  if (!agent) return relationshipError(404, 'AGENT_NOT_FOUND', 'Agent ' + agentId + ' not found');
  if (!canMutateAgent(agent, ownerId)) {
    return relationshipError(403, 'AGENT_FORBIDDEN', 'Agent ' + agentId + ' is not yours');
  }
  return { agent };
}

/**
 * A chat delivery must target a conversation that contains the agent
 * and is visible to the owner. Non-chat channels have no local target to check, and a chat
 * without a target falls back to the agent's own chat.
 */
export async function validateRoutineDelivery(
  store: Store,
  ownerId: string,
  agentId: string,
  delivery: Delivery,
): Promise<RelationshipError | undefined> {
  const target = delivery.target;
  if (delivery.channel !== 'chat' || target === undefined || target === '') return undefined;
  const conversation = await store.get('conversations', target);
  if (!conversation) {
    return relationshipError(400, 'ROUTINE_DELIVERY_NOT_FOUND', 'Delivery chat ' + target + ' not found');
  }
  if (!isConversationVisible(conversation, ownerId)) {
    return relationshipError(403, 'ROUTINE_DELIVERY_FORBIDDEN', 'Delivery chat ' + target + ' is not yours');
  }
  if (!conversation.agentIds.includes(agentId)) {
    return relationshipError(400, 'ROUTINE_DELIVERY_AGENT_MISSING', 'Delivery chat ' + target + ' does not include agent ' + agentId);
  }
  return undefined;
}

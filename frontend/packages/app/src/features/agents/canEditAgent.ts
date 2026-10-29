import type { Agent } from "@agent-desktop/client";

/**
 * Whether the signed-in owner may edit this agent (UI87). Ownership stays on the
 * server (`agent.createdBy`): a missing auth identity (standalone fixtures) or a
 * legacy agent without `createdBy` defaults to editable, while any other user only
 * gets the read-only view. The server still enforces the real write permission.
 */
export function canEditAgent(agent: Agent, ownerId: string | undefined): boolean {
  if (ownerId === undefined) return true;
  if (agent.createdBy === undefined) return true;
  return agent.createdBy === ownerId;
}

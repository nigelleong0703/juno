import type { Agent, Conversation } from "@agent-desktop/client";

export const GROUP_MIN = 2;
export const GROUP_MAX = 6;

export type Busy = "open" | "group" | null;

export type RetryKind = "open-direct" | "create-agent" | "create-group" | "send" | null;

export type Row =
  | { key: string; kind: "create" }
  | { key: string; kind: "group-entry" }
  | { key: string; kind: "agent"; agent: Agent }
  | { key: string; kind: "group"; conversation: Conversation };

/** Exact 1:1 for one agent: kind direct plus sole membership. Never a room or peer. */
export function findDirectFor(conversations: Conversation[] | undefined, agentId: string) {
  return (conversations ?? []).find(
    (entry) =>
      entry.kind === "direct" && entry.agentIds.length === 1 && entry.agentIds[0] === agentId,
  );
}

export function newRequestId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") return cryptoRef.randomUUID();
  return "req-" + Date.now() + "-" + Math.floor(Math.random() * 1000000000);
}

/** A room's display title: the member display names it actually carries. */
export function memberNamesTitle(agentIds: string[], agentById: Map<string, Agent>): string {
  return agentIds
    .map((id) => agentById.get(id)?.name ?? "")
    .filter((name) => name !== "")
    .join(", ");
}

export function conversationTitle(conversation: Conversation, agentById: Map<string, Agent>): string {
  return conversation.title ?? memberNamesTitle(conversation.agentIds, agentById);
}

export function matchingAgents(agents: Agent[], selectedIds: string[], needle: string): Agent[] {
  return agents.filter(
    (agent) =>
      !selectedIds.includes(agent.id) &&
      (needle === "" ||
        agent.name.toLowerCase().includes(needle) ||
        agent.handle.toLowerCase().includes(needle)),
  );
}

export function matchingGroups(
  conversations: Conversation[],
  agentById: Map<string, Agent>,
  needle: string,
): Conversation[] {
  return conversations.filter((entry) => {
    if (entry.kind !== "room" && entry.kind !== "peer") return false;
    if (needle === "") return true;
    return conversationTitle(entry, agentById).toLowerCase().includes(needle);
  });
}

export function composeRows(groupMode: boolean, agents: Agent[], groups: Conversation[]): Row[] {
  if (groupMode) return agents.map((agent): Row => ({ key: agent.id, kind: "agent", agent }));
  return [
    { key: "create", kind: "create" },
    { key: "group-entry", kind: "group-entry" },
    ...agents.map((agent): Row => ({ key: agent.id, kind: "agent", agent })),
    ...groups.map(
      (conversation): Row => ({ key: conversation.id, kind: "group", conversation }),
    ),
  ];
}

import type { Agent, Conversation } from "@agent-desktop/client";

export interface ChatEntry {
  conversation: Conversation;
  agents: Agent[];
  name: string;
}

/** Index agents by id for chat-row assembly. */
export function buildAgentIndex(agents: Agent[] | undefined): Map<string, Agent> {
  return new Map((agents ?? []).map((agent) => [agent.id, agent]));
}

/**
 * Chat rows for the sidebar list: task threads are excluded, names fall back from
 * title to members, search matches name/preview/handle, pinned sorts first.
 */
export function buildChatEntries(
  conversations: Conversation[] | undefined,
  agentById: Map<string, Agent>,
  search: string,
  untitled: string,
): ChatEntry[] {
  const rows = (conversations ?? [])
    .filter((conversation) => conversation.kind !== "task")
    .map((conversation) => {
      const members = conversation.agentIds.flatMap((id) => {
        const agent = agentById.get(id);
        return agent ? [agent] : [];
      });
      const isGroup = conversation.kind === "room" || conversation.kind === "peer";
      const fallback = isGroup
        ? members.map((member) => member.name).join(", ") || undefined
        : members[0]?.name;
      const name = conversation.title ?? fallback ?? untitled;
      return { conversation, agents: members, name };
    });

  const needle = search.trim().toLowerCase();
  const filtered = needle
    ? rows.filter(
        (row) =>
          row.name.toLowerCase().includes(needle) ||
          (row.conversation.lastMessagePreview ?? "").toLowerCase().includes(needle) ||
          row.agents.some((agent) => agent.handle.toLowerCase().includes(needle)),
      )
    : rows;

  return [...filtered].sort((a, b) => {
    const pinned = Number(Boolean(b.conversation.pinned)) - Number(Boolean(a.conversation.pinned));
    if (pinned !== 0) return pinned;
    return (
      new Date(b.conversation.lastItemAt).getTime() - new Date(a.conversation.lastItemAt).getTime()
    );
  });
}

/** Rename/delete target only direct chats, which resolve to their single agent. */
export function primaryAgentFor(entry: ChatEntry): Agent | undefined {
  if (entry.conversation.kind !== "direct") return undefined;
  return entry.agents[0];
}

export const CHAT_FILTERS = ["all", "unread", "needsYou", "groups"] as const;
export type ChatFilter = (typeof CHAT_FILTERS)[number];

/**
 * A chat that lives on a messaging platform and is not the owner's own conversation: a group / channel, or a stranger's
 * direct message (titled "Name · Slack"). The owner's DMs are the in-app chat, so these stay out of the main list.
 */
function isChannelChat(conversation: Conversation): boolean {
  return Boolean(conversation.channel) && (conversation.kind !== "direct" || Boolean(conversation.title));
}

/** A platform chip's filter value: every conversation on that messaging platform (own DM, groups, strangers). */
export const platformFilter = (kind: string): `platform:${string}` => `platform:${kind}`;

function matchesFilter({ conversation }: ChatEntry, filter: ChatFilter | `platform:${string}`): boolean {
  if (filter === "all") return !isChannelChat(conversation);
  if (filter === "unread") return conversation.unreadCount > 0;
  if (filter === "needsYou") return (conversation.needsYou ?? 0) > 0;
  // Groups are in-app group chats only; platform chats live under their platform chip.
  if (filter === "groups") return !conversation.channel && (conversation.kind === "room" || conversation.kind === "peer");
  if (filter.startsWith("platform:")) return conversation.channel?.kind === filter.slice("platform:".length);
  return true;
}

/** The Recents filter chips (All / Unread / Needs you / Groups / one per platform), as the iPhone Chats list has them. */
export function filterChatEntries(entries: ChatEntry[], filter: ChatFilter | `platform:${string}`): ChatEntry[] {
  return entries.filter((entry) => matchesFilter(entry, filter));
}

/** The platforms that have at least one conversation, in the order the platforms are listed. */
export function channelPlatformsIn(entries: ChatEntry[], order: string[]): string[] {
  const present = new Set(entries.flatMap((entry) => (entry.conversation.channel ? [entry.conversation.channel.kind as string] : [])));
  return order.filter((kind) => present.has(kind));
}

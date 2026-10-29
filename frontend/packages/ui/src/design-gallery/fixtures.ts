import { buildWorld } from "@agent-desktop/test-fixtures";
import type { MockState } from "@agent-desktop/test-fixtures";

/**
 * Model types inferred from the seeded fixture world instead of importing the
 * client package: the gallery is a UI-only consumer and must not reach across
 * the ARCHITECTURE §3 boundary into packages/client.
 */
export type GalleryAgent = MockState["agents"][number];
export type GalleryConversation = MockState["conversations"][number];
export type GalleryRun = MockState["runs"][number];
export type GalleryItem = NonNullable<ReturnType<MockState["items"]["get"]>>[number];

/** Fixed gallery clock so seeded ids and timestamps never shift between renders. */
export const GALLERY_NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

let cached: MockState | null = null;

/** The production mock world (seed 1): every fixture below is real seeded data. */
export function galleryState(): MockState {
  if (cached === null) cached = buildWorld(GALLERY_NOW, 1);
  return cached;
}

export interface MessageThread {
  conversation: GalleryConversation;
  items: GalleryItem[];
  agents: GalleryAgent[];
}

function agentsFor(state: MockState, conversation: GalleryConversation): GalleryAgent[] {
  return conversation.agentIds.flatMap((id) => state.agents.find((agent) => agent.id === id) ?? []);
}

/** First direct conversation with at least two message items. */
export function directThread(state: MockState): MessageThread | undefined {
  for (const conversation of state.conversations) {
    if (conversation.kind !== "direct") continue;
    const items = state.items.get(conversation.id) ?? [];
    const messages = items.filter((item) => item.type === "user_message" || item.type === "agent_message");
    if (messages.length >= 2) return { conversation, items, agents: agentsFor(state, conversation) };
  }
  return undefined;
}

/** First room conversation with items (group-chat authorship coverage). */
export function roomThread(state: MockState): MessageThread | undefined {
  for (const conversation of state.conversations) {
    if (conversation.kind !== "room") continue;
    const items = state.items.get(conversation.id) ?? [];
    if (items.length > 0) return { conversation, items, agents: agentsFor(state, conversation) };
  }
  return undefined;
}

/** The answering agent for a fixture conversation. */
export function primaryAgent(state: MockState, conversation: GalleryConversation): GalleryAgent | undefined {
  const id = conversation.agentIds[0];
  if (id === undefined) return undefined;
  return state.agents.find((agent) => agent.id === id);
}

/**
 * First running chat run, re-scoped to the fixture conversation with a typed
 * copy (no cast). Drives the waiting/generating states without touching data.
 */
export function waitingRun(state: MockState, conversationId: string): GalleryRun | undefined {
  const run = state.runs.find((candidate) => candidate.status === "running" && candidate.kind === "chat");
  if (run === undefined) return undefined;
  if (run.conversationId === conversationId) return run;
  return { ...run, conversationId };
}

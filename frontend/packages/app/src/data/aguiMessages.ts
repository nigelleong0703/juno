/**
 * Transcript projection for standard AG-UI messages.
 *
 * Product clients receive the authoritative `item.added` row as well as the standard text
 * sequence. Both use the same message/item id, so a committed assistant message is only a fallback:
 * it is inserted when the item has not arrived, and `item.added` then replaces that same row.
 */
import type { AgentEvent, Item } from "@agent-desktop/client";
import { EventType, itemSchema } from "@agent-desktop/client";
import type { QueryClient } from "@tanstack/react-query";
import { atOf, isRecord, junoRecordOf } from "./aguiMetadata";
import { mergeItemChronologically } from "./events";
import { qk } from "./keys";

interface PendingMessage {
  conversationId: string;
  agentId: string;
  runId?: string;
  text: string;
  at: string;
}

const pending = new Map<string, PendingMessage>();
const completed = new Map<string, true>();
const MAX_PENDING = 128;
const MAX_COMPLETED = 512;

function messageKey(conversationId: string, messageId: string): string {
  return conversationId + "\u0000" + messageId;
}

function bound(map: Map<string, unknown>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.flatMap((part) => isRecord(part) && part["type"] === "text" && typeof part["text"] === "string" ? [part["text"]] : []).join("");
}

type SnapshotMessage = Extract<AgentEvent, { type: EventType.MESSAGES_SNAPSHOT }>["messages"][number];

function itemFromMessage(message: SnapshotMessage, conversationId: string, at: string): Item | undefined {
  const metadata = "metadata" in message ? message.metadata : undefined;
  const juno = junoRecordOf(metadata);
  const embedded = juno?.["item"];
  const parsed = itemSchema.safeParse(embedded);
  if (parsed.success) return parsed.data;

  const text = textOf("content" in message ? message.content : undefined);
  if (text === undefined) return undefined;
  if (message.role === "assistant") {
    const agentId = juno?.["agentId"];
    if (typeof agentId !== "string") return undefined;
    const runId = juno?.["runId"];
    return {
      id: message.id,
      conversationId,
      at,
      type: "agent_message",
      agentId,
      ...(typeof runId === "string" ? { runId } : {}),
      markdown: text,
      citations: [],
    };
  }
  if (message.role === "user") {
    const authorId = juno?.["authorId"];
    if (typeof authorId !== "string") return undefined;
    return {
      id: message.id,
      conversationId,
      at,
      type: "user_message",
      authorId,
      text,
      attachments: [],
      mentions: [],
    };
  }
  return undefined;
}

function applySnapshot(qc: QueryClient, event: Extract<AgentEvent, { type: EventType.MESSAGES_SNAPSHOT }>): void {
  const conversationId = junoRecordOf(event.metadata)?.["conversationId"];
  if (typeof conversationId !== "string") return;
  const at = atOf(event.timestamp);
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const message of event.messages) {
    const item = itemFromMessage(message, conversationId, at);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  // The snapshot is a recovery aid, not a deletion authority: it carries no page/outbox waterline.
  // Merge the rows it does provide and retain optimistic placeholders plus older loaded pages.
  qc.setQueryData<Item[]>(qk.items(conversationId), (old) => items.reduce((current, item) => mergeItemChronologically(current, item), old ?? []));
}

function startMessage(event: Extract<AgentEvent, { type: EventType.TEXT_MESSAGE_START }>): void {
  const role = event.role ?? "assistant";
  if (role !== "assistant") return;
  const juno = junoRecordOf(event.metadata);
  if (!juno) return;
  const conversationId = juno["conversationId"];
  const agentId = juno["agentId"];
  if (typeof conversationId !== "string" || typeof agentId !== "string") return;
  const key = messageKey(conversationId, event.messageId);
  if (completed.has(key)) return;
  const current = pending.get(key);
  if (current) {
    // A replay may resend START after part of the text; it must not erase accepted content.
    pending.set(key, { ...current, agentId });
    return;
  }
  const runId = juno["runId"];
  pending.set(key, {
    conversationId,
    agentId,
    ...(typeof runId === "string" ? { runId } : {}),
    text: "",
    at: atOf(event.timestamp),
  });
  bound(pending, MAX_PENDING);
}

function contentMessage(event: Extract<AgentEvent, { type: EventType.TEXT_MESSAGE_CONTENT }>): void {
  const conversationId = junoRecordOf(event.metadata)?.["conversationId"];
  if (typeof conversationId !== "string") return;
  const key = messageKey(conversationId, event.messageId);
  const message = pending.get(key);
  if (!message) return;
  pending.set(key, { ...message, text: message.text + event.delta });
}

function endMessage(qc: QueryClient, event: Extract<AgentEvent, { type: EventType.TEXT_MESSAGE_END }>): void {
  const conversationId = junoRecordOf(event.metadata)?.["conversationId"];
  if (typeof conversationId !== "string") return;
  const key = messageKey(conversationId, event.messageId);
  const message = pending.get(key);
  if (!message) return;
  pending.delete(key);
  completed.set(key, true);
  bound(completed, MAX_COMPLETED);
  const current = qc.getQueryData<Item[]>(qk.items(message.conversationId));
  if (current?.some((item) => item.id === event.messageId)) return;
  const item: Item = {
    id: event.messageId,
    conversationId: message.conversationId,
    at: message.at,
    type: "agent_message",
    agentId: message.agentId,
    ...(message.runId === undefined ? {} : { runId: message.runId }),
    markdown: message.text,
    citations: [],
  };
  qc.setQueryData<Item[]>(qk.items(message.conversationId), (old) => mergeItemChronologically(old ?? [], item));
}

/** Project MESSAGES_SNAPSHOT and committed TEXT_MESSAGE_* sequences into the transcript cache. */
export function applyAguiMessageEvent(qc: QueryClient, event: AgentEvent): void {
  if (event.type === EventType.MESSAGES_SNAPSHOT) return applySnapshot(qc, event);
  if (event.type === EventType.TEXT_MESSAGE_START) return startMessage(event);
  if (event.type === EventType.TEXT_MESSAGE_CONTENT) return contentMessage(event);
  if (event.type === EventType.TEXT_MESSAGE_END) return endMessage(qc, event);
}

/** Drop half-seen fallback messages at the same account and reset boundaries as preview state. */
export function resetAguiMessages(): void {
  pending.clear();
  completed.clear();
}

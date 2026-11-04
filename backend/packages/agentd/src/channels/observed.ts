/**
 * What the agent observed in a group (BACKEND 6.8). Every message of a group the platform delivers is stored in its conversation
 * (`observed: true` on the item) and counted by the chat digest, which turns them into the team picture; none of them starts a run. When
 * the agent is addressed, the run gets the messages it observed since its last turn in that thread, verbatim and in order, in the
 * wake (after the cached prefix, append-only). Older ones reach it only through the picture and memory.
 *
 * Where they live: a thread's observed messages in the thread's conversation; a channel's top-level messages in the channel's own
 * conversation (thread id = the chat id), which a mention at the top level reads too (its thread is new).
 */
import type { Store } from '@agent-desktop/contracts';
import { channelConversationId } from '../routes/channels.js';

/** The verbatim backlog a run gets: this many messages, this many characters, newest kept. */
export const OBSERVED_MAX_MESSAGES = 30;
export const OBSERVED_MAX_CHARS = 6000;
const OBSERVED_LINE_CHARS = 600;

export interface ObservedMessage {
  who: string;
  at: string;
  text: string;
}

type SeenConversation = { observedSeenAt?: string };

async function observedIn(store: Store, conversationId: string): Promise<{ messages: ObservedMessage[]; newest?: string }> {
  const conversation = await store.get('conversations', conversationId);
  if (conversation === null) return { messages: [] };
  const seenAt = (conversation as SeenConversation).observedSeenAt;
  const page = await store.list('items', { where: { conversationId }, orderBy: 'at', order: 'desc', limit: 100 });
  const messages: ObservedMessage[] = [];
  let newest: string | undefined;
  for (const item of page.items) {
    if (item.type !== 'user_message' || item.observed !== true) continue;
    if (seenAt !== undefined && item.at <= seenAt) break;
    newest ??= item.at;
    messages.push({ who: item.channelSender?.name ?? '', at: item.at, text: item.text.replace(/\s+/g, ' ').trim().slice(0, OBSERVED_LINE_CHARS) });
    if (messages.length >= OBSERVED_MAX_MESSAGES) break;
  }
  return { messages: messages.reverse(), ...(newest === undefined ? {} : { newest }) };
}

/** The observed messages this run has not read yet (marking them read), oldest first, within the caps. */
export async function takeObserved(
  store: Store,
  ownerId: string,
  where: { kind: string; channelId: string; chatId: string; threadId: string; conversationId: string },
): Promise<ObservedMessage[]> {
  const sources = [where.conversationId];
  if (where.threadId !== where.chatId) sources.push(channelConversationId(ownerId, where.kind, where.channelId, where.chatId));
  const taken: ObservedMessage[] = [];
  for (const id of sources) {
    const found = await observedIn(store, id);
    if (found.newest === undefined) continue;
    taken.push(...found.messages);
    const seen: Partial<SeenConversation> = { observedSeenAt: found.newest };
    await store.patch('conversations', id, seen as never);
  }
  taken.sort((a, b) => a.at.localeCompare(b.at));
  // Newest kept within the caps.
  let chars = 0;
  const kept: ObservedMessage[] = [];
  for (const message of [...taken].reverse().slice(0, OBSERVED_MAX_MESSAGES)) {
    chars += message.text.length + message.who.length;
    if (chars > OBSERVED_MAX_CHARS) break;
    kept.push(message);
  }
  return kept.reverse();
}

/** Reads what is new for the memory jobs: the user's messages and their agents' replies (the daily logs are no longer read). */
import type { Item } from '@agent-desktop/public-contracts';
import type { Store } from '../../../contracts/index.js';

/** Characters of one message the model is shown; the evidence quote must lie inside what it was shown. */
const MAX_ITEM_CHARS = 2_000;
/** Characters of conversation per job run; the rest waits for the next run (the checkpoint stops at the last message shown). */
export const MAX_SOURCE_CHARS = 60_000;
const PAGE = 200;

export interface SourceItem {
  id: string;
  conversationId: string;
  at: string;
  /** `other`: a user message written by someone who is not the owner (a room member); it may only feed people pages. */
  role: 'user' | 'agent' | 'other';
  agentId?: string;
  runId?: string;
  text: string;
  /** For `other`: the platform account that wrote it (its platform, the chat's channel and the sender's id and name), so the job can find the sender's person. */
  from?: { kind: string; channelId?: string; externalId: string; name: string };
}

/** `agent:<id>`: the platform sender id agentd gives another of the owner's agents speaking in a chat (its post is stored as a user_message). */
const AGENT_SENDER_PREFIX = 'agent:';

const textOf = (item: Item, ownerId: string): SourceItem | undefined => {
  if (item.type === 'user_message') {
    const sender = item.channelSender?.externalId;
    // An agent's post in a platform chat is agent text (context, never a person's words), not an unknown human.
    if (sender?.startsWith(AGENT_SENDER_PREFIX) === true) return { id: item.id, conversationId: item.conversationId, at: item.at, role: 'agent', agentId: sender.slice(AGENT_SENDER_PREFIX.length), text: item.text };
    const from = item.channelSender === undefined ? undefined : { kind: item.channelSender.kind, ...(item.source?.channelId === undefined ? {} : { channelId: item.source.channelId }), externalId: item.channelSender.externalId, name: item.channelSender.name };
    return { id: item.id, conversationId: item.conversationId, at: item.at, role: item.authorId === ownerId ? 'user' : 'other', text: item.text, ...(from === undefined ? {} : { from }) };
  }
  if (item.type === 'agent_message') return { id: item.id, conversationId: item.conversationId, at: item.at, role: 'agent', agentId: item.agentId, ...(item.runId === undefined ? {} : { runId: item.runId }), text: item.markdown };
  return undefined;
};

/**
 * The owner's messages newer than `after`, oldest first. `budget` limits the characters returned; the first message is always
 * returned so a long one cannot block the job forever. `conversationId` limits it to one conversation. Must run inside the owner's
 * scope (the store is owner scoped).
 */
export async function itemsSince(store: Store, ownerId: string, after: string | undefined, budget = MAX_SOURCE_CHARS, conversationId?: string): Promise<SourceItem[]> {
  const found: SourceItem[] = [];
  let cursor: string | undefined;
  for (let done = false; !done;) {
    const page = await store.list('items', { orderBy: 'at', order: 'desc', limit: PAGE, ...(conversationId === undefined ? {} : { where: { conversationId } }), ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) {
      if (after !== undefined && item.at <= after) {
        done = true;
        break;
      }
      const source = textOf(item, ownerId);
      if (source !== undefined) {
        found.push({ ...source, text: source.text.length > MAX_ITEM_CHARS ? source.text.slice(0, MAX_ITEM_CHARS) : source.text });
      }
    }
    cursor = page.nextCursor;
    if (cursor === undefined || page.items.length === 0) done = true;
  }
  found.reverse();
  const picked: SourceItem[] = [];
  let used = 0;
  for (const item of found) {
    if (picked.length > 0 && used + item.text.length > budget) break;
    picked.push(item);
    used += item.text.length;
  }
  return picked;
}


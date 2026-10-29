/**
 * The person's own words behind a memory item (`MemoryItemView.quote`, BACKEND §10.17). The words are the evidence quote the item was
 * written with (`memory_items.evidence`: the message id and the words copied from it, checked against the message when the item was made);
 * the message is read here only to say when it was written and to refuse anything that is not a person's message.
 */
import type { Store } from '@agent-desktop/contracts';
import type { MemoryItem } from '@agent-desktop/memory-graph/memory';
import type { MemoryItemView } from '@agent-desktop/public-contracts';

export const QUOTE_MAX = 280;
/** Evidence entries looked at per item: an item merged many times keeps all its quotes; the first few are enough to find a usable one. */
const ENTRIES_PER_ITEM = 3;
const LOG_PREFIX = 'log:';

type Quote = NonNullable<MemoryItemView['quote']>;

/** At most `QUOTE_MAX` characters in all: cut at the last space and closed with "…"; text without spaces (Chinese) is cut on a character. */
export function trimQuote(raw: string): string {
  const text = raw.trim();
  const chars = Array.from(text);
  if (chars.length <= QUOTE_MAX) return text;
  const room = chars.slice(0, QUOTE_MAX - 1).join('');
  const space = room.search(/\s\S*$/);
  // A space near the start of an otherwise unbroken text (a Chinese sentence after "OK ") is no word boundary worth cutting at.
  const cut = space > room.length / 2 ? room.slice(0, space) : room;
  return cut.trimEnd().replace(/[,;:.\-–—]+$/, '') + '…';
}

/**
 * The quote of each item that has one, by item id. One read of the messages for all the items. A message that is gone (its
 * conversation was deleted), was written by an agent or is not a message at all (a tool result, a log line) gives no quote, and neither
 * does one whose text no longer holds the quoted words.
 */
export async function quotesOf(store: Store, items: readonly MemoryItem[]): Promise<Map<string, Quote>> {
  const entries = new Map(items.map((item): [string, ReadonlyArray<{ itemId: string; quote: string }>] => [
    item.id,
    (item.evidence ?? []).filter((entry) => !entry.itemId.startsWith(LOG_PREFIX)).slice(0, ENTRIES_PER_ITEM),
  ]));
  const ids = [...new Set([...entries.values()].flatMap((list) => list.map((entry) => entry.itemId)))];
  const quotes = new Map<string, Quote>();
  if (ids.length === 0) return quotes;
  const messages = new Map((await store.list('items', { where: { ids }, limit: ids.length })).items.map((message) => [message.id, message]));
  for (const [itemId, list] of entries) {
    for (const entry of list) {
      const message = messages.get(entry.itemId);
      if (message?.type !== 'user_message' || message.channelSender?.externalId.startsWith('agent:') === true) continue;
      const words = entry.quote.trim();
      if (words === '' || !message.text.includes(words)) continue;
      quotes.set(itemId, { text: trimQuote(words), at: message.at });
      break;
    }
  }
  return quotes;
}

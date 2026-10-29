// Untrusted store reads for the social context: every record lookup can be
// missing or unreadable, and every stored field is data, never instructions.
import type { Collection, Doc, Store } from '../../contracts/index.js';

export type ReadResult<C extends Collection> =
  | { status: 'ok'; doc: Doc<C> }
  | { status: 'missing' }
  | { status: 'error' };

export async function safeGet<C extends Collection>(
  store: Store,
  collection: C,
  id: string,
): Promise<ReadResult<C>> {
  try {
    const doc = await store.get(collection, id);
    if (doc === null) return { status: 'missing' };
    return { status: 'ok', doc };
  } catch {
    return { status: 'error' };
  }
}

export function readString(doc: object, key: string): string | undefined {
  const value: unknown = Reflect.get(doc, key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The platform a conversation is bound to (discord, slack, telegram, feishu, ...), undefined for a chat or room that lives in the app. */
export function readChannelKind(doc: object): string | undefined {
  const channel: unknown = Reflect.get(doc, 'channel');
  if (typeof channel !== 'object' || channel === null) return undefined;
  const kind: unknown = Reflect.get(channel, 'kind');
  return typeof kind === 'string' && kind.length > 0 ? kind : undefined;
}

export function readStringArray(doc: object, key: string): string[] | undefined {
  const value: unknown = Reflect.get(doc, key);
  if (!Array.isArray(value)) return undefined;
  const items: unknown[] = value;
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === 'string' && item.length > 0) out.push(item);
  }
  return out;
}

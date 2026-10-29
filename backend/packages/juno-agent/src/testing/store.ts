/**
 * In-memory Store plus NoopEnqueuer, for tests and dev (db re-exports createMemoryStore).
 *
 * It carries the full createMemoryStore owner/event-isolation semantics. The owner rules themselves
 * (UNKNOWN_OWNER, ownerCollisionMessage, resolveEventOwner) are production logic shared with the Postgres
 * store and live in contracts/owner-events.ts; this file imports nothing outside the package (no db,
 * log, or service packages). Not a production adapter: there is no Postgres here.
 */
import type { EventBus, StoredEvent } from '../contracts/events.js';
import type { AgentEvent } from '@agent-desktop/public-contracts';
import type { Collection, Doc, IndexedFields, ListPage, ListQuery, Store } from '../contracts/storage.js';
import { NotFoundError } from '../contracts/storage.js';
import { UNKNOWN_OWNER, ownerCollisionMessage, resolveEventOwner, type OwnerLookup } from '../contracts/owner-events.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Documents handed to the store are always plain objects. */
function toRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError('expected a plain object document');
  }
  return value;
}

/** Every stored document carries a string id; that is enough to recover Doc on read. */
function isDoc<C extends Collection>(value: unknown): value is Doc<C> {
  return isRecord(value) && typeof value['id'] === 'string';
}

function readString(rec: Record<string, unknown>, key: string): string | undefined {
  const value = rec[key];
  return typeof value === 'string' ? value : undefined;
}

const INDEXED_KEYS = ['agentId', 'conversationId', 'runId', 'status', 'kind', 'parentId'] as const;

/**
 * The indexed fields of a doc, like the Postgres projection (db/src/queries.ts): an explicit index wins,
 * otherwise the doc's own field; docs with a `sessionKey` and no `kind` are indexed by it.
 */
function withSessionKind(record: Record<string, unknown>, index: IndexedFields | undefined): IndexedFields {
  const base: IndexedFields = { ...index };
  for (const key of INDEXED_KEYS) {
    const own = readString(record, key);
    if (base[key] === undefined && own !== undefined) base[key] = own;
  }
  // A child run names its parent in `parentRunId`; that is what the indexed parent holds for a run (db/src/queries.ts).
  const parentRunId = readString(record, 'parentRunId');
  if (base.parentId === undefined && parentRunId !== undefined) base.parentId = parentRunId;
  const sessionKey = readString(record, 'sessionKey');
  if (base.kind !== undefined || sessionKey === undefined) return base;
  return { ...base, kind: sessionKey };
}

/** A patch that changes an indexed field moves the index with it, as the Postgres patch does. */
function patchedIndex(index: IndexedFields, changes: Record<string, unknown>): IndexedFields {
  const next: IndexedFields = { ...index };
  for (const key of INDEXED_KEYS) {
    if (Object.hasOwn(changes, key)) next[key] = readString(changes, key) ?? null;
  }
  return next;
}


interface InMemoryDoc {
  doc: Record<string, unknown>;
  index: IndexedFields;
  createdAt: string;
  ownerId: string;
}

function docTimestamp(item: InMemoryDoc): string {
  return readString(item.doc, 'at') || readString(item.doc, 'createdAt') || readString(item.doc, 'startedAt') || item.createdAt;
}

function docId(item: InMemoryDoc): string {
  return readString(item.doc, 'id') || '';
}

function matchesWhere(item: InMemoryDoc, where: NonNullable<ListQuery['where']>): boolean {
  if (where.ids && !where.ids.includes(docId(item))) return false;
  if (where.agentId && item.index.agentId !== where.agentId) return false;
  if (where.conversationId && item.index.conversationId !== where.conversationId) return false;
  if (where.runId && item.index.runId !== where.runId) return false;
  if (where.status && item.index.status !== where.status) return false;
  if (where.kind && item.index.kind !== where.kind) return false;
  if (where.parentId && item.index.parentId !== where.parentId) return false;
  if (where.statuses && !where.statuses.includes(item.index.status ?? '')) return false;
  if (where.hasParent !== undefined && (item.index.parentId != null) !== where.hasParent) return false;
  const routineId = readString(item.doc, 'routineId');
  if (where.hasRoutine !== undefined && (routineId !== undefined) !== where.hasRoutine) return false;
  if (where.routineId !== undefined && routineId !== where.routineId) return false;
  const initiator = item.doc['initiator'];
  if (where.initiator !== undefined && !(typeof initiator === 'object' && initiator !== null && Reflect.get(initiator, 'type') === where.initiator)) return false;
  if (where.unattended !== undefined && item.doc['unattended'] !== where.unattended) return false;
  return true;
}
function sortDocs(items: InMemoryDoc[], orderBy: 'at' | 'id', order: 'asc' | 'desc'): void {
  items.sort((a, b) => {
    const aVal = orderBy === 'at' ? docTimestamp(a) : docId(a);
    const bVal = orderBy === 'at' ? docTimestamp(b) : docId(b);
    // Equal timestamps order by id, as the Postgres store does.
    const cmp = aVal.localeCompare(bVal) || (orderBy === 'at' ? binaryCompare(docId(a), docId(b)) : 0);
    return order === 'asc' ? cmp : -cmp;
  });
}

function binaryCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Keep the rows strictly after `keyset` in the query's order (the Postgres store's `keyset`). */
function afterKeyset(items: InMemoryDoc[], keyset: NonNullable<ListQuery['keyset']>, order: 'asc' | 'desc'): InMemoryDoc[] {
  const sign = order === 'asc' ? 1 : -1;
  return items.filter((item) => {
    const cmp = binaryCompare(docTimestamp(item), keyset.at) || binaryCompare(docId(item), keyset.id);
    return cmp * sign > 0;
  });
}

function pageDocs<C extends Collection>(items: InMemoryDoc[], query?: ListQuery): ListPage<Doc<C>> {
  const orderBy = query?.orderBy || 'id';
  const order = query?.order || 'asc';
  sortDocs(items, orderBy, order);
  let startIdx = 0;
  if (query?.cursor) {
    const cursorId = query.cursor.split(':')[1] ?? '';
    const found = items.findIndex((item) => docId(item) === cursorId);
    if (found >= 0) startIdx = found + 1;
  }
  const limit = query?.limit || 20;
  const pageItems = items.slice(startIdx, startIdx + limit);
  const last = pageItems[pageItems.length - 1];
  const nextCursor = startIdx + limit < items.length && last ? startIdx + limit + ':' + docId(last) : undefined;
  const docs: Doc<C>[] = [];
  for (const item of pageItems) {
    if (isDoc<C>(item.doc)) docs.push(item.doc);
  }
  return { items: docs, nextCursor };
}

function filterDocs<C extends Collection>(col: Map<string, InMemoryDoc>, query?: ListQuery): ListPage<Doc<C>> {
  let items = Array.from(col.values());
  if (query?.where) {
    const where = query.where;
    items = items.filter((item) => matchesWhere(item, where));
  }
  if (query?.keyset) items = afterKeyset(items, query.keyset, query.order ?? 'asc');
  return pageDocs<C>(items, query);
}

export function createMemoryStore(): Store & { eventBus: EventBus } {
  const collections = new Map<Collection, Map<string, InMemoryDoc>>();
  // Row mutexes emulating SELECT ... FOR UPDATE: one transaction holds a row at a time,
  // released when its tx body returns.
  const rowLocks = new Map<string, Promise<void>>();
  const acquireRowLock = async (key: string): Promise<() => void> => {
    const prev = rowLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => current);
    rowLocks.set(key, chained);
    await prev;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      if (rowLocks.get(key) === chained) rowLocks.delete(key);
    };
  };
  let eventId = 0;
  const events: Map<number, StoredEvent> = new Map();
  const eventOwners: Map<number, string> = new Map();
  const subscribers: Set<(e: StoredEvent) => void> = new Set();

  const collectionFor = (name: Collection): Map<string, InMemoryDoc> => {
    let col = collections.get(name);
    if (!col) {
      col = new Map();
      collections.set(name, col);
    }
    return col;
  };

  const ownerOf = (collection: Collection, id: string): string | undefined =>
    collections.get(collection)?.get(id)?.ownerId;

  const scopedMemory = (owner: string): Store => ({
    forOwner: (next: string) => scopedMemory(next),
    async tx<T>(fn: (scoped: Store) => Promise<T>): Promise<T> {
      // Physical-row key shared with the raw store (id is globally unique, owner is a
      // column not part of identity, exactly like Postgres); the locked get below still
      // enforces this owner's visibility. Reentrant: relocking a held row returns the read.
      const held = new Map<string, () => void>();
      const txScoped: Store = {
        ...scopedMemory(owner),
        getForUpdate: async <C extends Collection>(collection: C, id: string): Promise<Doc<C> | null> => {
          const key = String(collection) + ':' + id;
          if (!held.has(key)) held.set(key, await acquireRowLock(key));
          return txScoped.get(collection, id);
        },
      };
      try {
        return await fn(txScoped);
      } finally {
        for (const release of held.values()) release();
        held.clear();
      }
    },
    async get<C extends Collection>(collection: C, id: string): Promise<Doc<C> | null> {
      const item = collectionFor(collection).get(id);
      if (!item || item.ownerId !== owner || !isDoc<C>(item.doc)) return null;
      return item.doc;
    },
    async getForUpdate<C extends Collection>(collection: C, id: string): Promise<Doc<C> | null> {
      void collection;
      void id;
      throw new Error('getForUpdate requires a transaction: refusing unlocked row access');
    },
    async list<C extends Collection>(collection: C, query?: ListQuery): Promise<ListPage<Doc<C>>> {
      const owned = new Map<string, InMemoryDoc>();
      for (const [id, item] of collectionFor(collection)) {
        if (item.ownerId === owner) owned.set(id, item);
      }
      return filterDocs<C>(owned, query);
    },
    async put<C extends Collection>(collection: C, doc: Doc<C>, index?: IndexedFields): Promise<Doc<C>> {
      const col = collectionFor(collection);
      const record = toRecord(doc);
      const id = readString(record, 'id') || '';
      const existing = col.get(id);
      if (existing && existing.ownerId !== owner) {
        throw new Error(ownerCollisionMessage(String(collection), id));
      }
      const forced = { ...record, ownerId: owner };
      col.set(id, { doc: forced, index: withSessionKind(forced, index), createdAt: new Date().toISOString(), ownerId: owner });
      const out: unknown = forced;
      if (!isDoc<C>(out)) {
        throw new TypeError(String(collection) + ' doc.id must be a string');
      }
      return out;
    },
    async patch<C extends Collection>(collection: C, id: string, patch: Partial<Doc<C>>): Promise<Doc<C>> {
      const col = collectionFor(collection);
      const item = col.get(id);
      if (!item || item.ownerId !== owner) {
        throw new NotFoundError(String(collection), id);
      }
      const changes = { ...toRecord(patch) };
      delete changes.id;
      delete changes.ownerId;
      delete changes.owner_id;
      const merged: Record<string, unknown> = { ...item.doc, ...changes };
      col.set(id, { doc: merged, index: patchedIndex(item.index, changes), createdAt: item.createdAt, ownerId: owner });
      const stored = col.get(id);
      if (!stored || !isDoc<C>(stored.doc)) {
        throw new TypeError(String(collection) + ' doc must be an object with a string id');
      }
      return stored.doc;
    },
    async delete(collection: Collection, id: string): Promise<void> {
      const col = collections.get(collection);
      if (col?.get(id)?.ownerId === owner) col.delete(id);
    },
    async emit(event: AgentEvent): Promise<void> {
      eventId++;
      const storedEvent: StoredEvent = { id: eventId, event, at: new Date().toISOString() };
      events.set(eventId, storedEvent);
      eventOwners.set(eventId, owner);
      subscribers.forEach((cb) => cb(storedEvent));
    },
  });

  const store: Store = {
    forOwner: (ownerId: string) => scopedMemory(ownerId),
    async tx<T>(fn: (s: Store) => Promise<T>): Promise<T> {
      const held = new Map<string, () => void>();
      const txStore: Store = {
        ...store,
        getForUpdate: async <C extends Collection>(collection: C, id: string): Promise<Doc<C> | null> => {
          const key = String(collection) + ':' + id;
          if (!held.has(key)) held.set(key, await acquireRowLock(key));
          return txStore.get(collection, id);
        },
      };
      try {
        return await fn(txStore);
      } finally {
        for (const release of held.values()) release();
        held.clear();
      }
    },
    async get<C extends Collection>(collection: C, id: string): Promise<Doc<C> | null> {
      const item = collectionFor(collection).get(id);
      if (!item || !isDoc<C>(item.doc)) return null;
      return item.doc;
    },
    async getForUpdate<C extends Collection>(collection: C, id: string): Promise<Doc<C> | null> {
      void collection;
      void id;
      throw new Error('getForUpdate requires a transaction: refusing unlocked row access');
    },
    async list<C extends Collection>(collection: C, query?: ListQuery): Promise<ListPage<Doc<C>>> {
      return filterDocs<C>(collectionFor(collection), query);
    },
    async put<C extends Collection>(collection: C, doc: Doc<C>, index?: IndexedFields): Promise<Doc<C>> {
      const col = collectionFor(collection);
      const record = toRecord(doc);
      col.set(readString(record, 'id') || '', {
        doc: record,
        index: withSessionKind(record, index),
        createdAt: new Date().toISOString(),
        ownerId: readString(record, 'ownerId') ?? UNKNOWN_OWNER,
      });
      return doc;
    },
    async patch<C extends Collection>(collection: C, id: string, patch: Partial<Doc<C>>): Promise<Doc<C>> {
      const col = collectionFor(collection);
      const item = col.get(id);
      if (!item) {
        throw new NotFoundError(String(collection), id);
      }
      const merged: Record<string, unknown> = { ...item.doc, ...toRecord(patch) };
      col.set(id, { doc: merged, index: patchedIndex(item.index, toRecord(patch)), createdAt: item.createdAt, ownerId: item.ownerId });
      const stored = col.get(id);
      if (!stored || !isDoc<C>(stored.doc)) {
        throw new TypeError(String(collection) + ' doc must be an object with a string id');
      }
      return stored.doc;
    },
    async delete(collection: Collection, id: string): Promise<void> {
      collections.get(collection)?.delete(id);
    },
    async emit(event: AgentEvent): Promise<void> {
      eventId++;
      const storedEvent: StoredEvent = { id: eventId, event, at: new Date().toISOString() };
      const lookup: OwnerLookup = async (collection, id) => ownerOf(collection, id);
      events.set(eventId, storedEvent);
      eventOwners.set(eventId, await resolveEventOwner(event, lookup));
      subscribers.forEach((cb) => cb(storedEvent));
    },
  };

  const headId = async (): Promise<number> => Math.max(0, ...events.keys());
  const prune = async (before: Date): Promise<number> => {
    let removed = 0;
    for (const [id, stored] of events) {
      if (Date.parse(stored.at) >= before.getTime()) continue;
      events.delete(id);
      eventOwners.delete(id);
      removed += 1;
    }
    return removed;
  };
  const scopedBus = (busOwner: string): EventBus => ({
    head: headId,
    prune,
    async since(afterId: number, limit?: number): Promise<StoredEvent[]> {
      const maxCount = limit || 100;
      const result: StoredEvent[] = [];
      for (const [id, stored] of events) {
        if (id > afterId && eventOwners.get(id) === busOwner) {
          result.push(stored);
          if (result.length >= maxCount) break;
        }
      }
      return result.sort((a, b) => a.id - b.id);
    },
    async subscribe(onEvent: (e: StoredEvent) => void): Promise<() => void> {
      const filtered = (e: StoredEvent): void => {
        if (eventOwners.get(e.id) === busOwner) onEvent(e);
      };
      subscribers.add(filtered);
      return () => {
        subscribers.delete(filtered);
      };
    },
  });

  const eventBus: EventBus = {
    forOwner: (ownerId: string) => scopedBus(ownerId),
    head: headId,
    prune,
    async since(afterId: number, limit?: number): Promise<StoredEvent[]> {
      const result: StoredEvent[] = [];
      const maxCount = limit || 100;
      let count = 0;
      for (const [id, event] of events) {
        if (id > afterId && count < maxCount) {
          result.push(event);
          count++;
        }
      }
      return result.sort((a, b) => a.id - b.id);
    },
    async subscribe(onEvent: (e: StoredEvent) => void): Promise<() => void> {
      subscribers.add(onEvent);
      return () => {
        subscribers.delete(onEvent);
      };
    },
  };

  return { ...store, eventBus };
}

/**
 * Noop enqueuer for testing (records calls without side effects).
 */
export class NoopEnqueuer {
  calls: Array<{ method: string; args: unknown[] }> = [];

  constructor() {}

  async enqueue(): Promise<{ accepted: boolean; reason?: string }> {
    this.calls.push({ method: 'enqueue', args: [] });
    return { accepted: true };
  }

  async stopRun(): Promise<void> {
    this.calls.push({ method: 'stopRun', args: [] });
  }

  async resolveAwakeable(): Promise<void> {
    this.calls.push({ method: 'resolveAwakeable', args: [] });
  }

  async scheduleRoutine(): Promise<void> {
    this.calls.push({ method: 'scheduleRoutine', args: [] });
  }
}

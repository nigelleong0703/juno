// Storage isolation for the managed connection: hide it without deleting the saved row.
import type { AgentEvent } from '@agent-desktop/public-contracts';
import type { Store } from '../contracts/index.js';
import type { Collection, Doc, IndexedFields, ListPage, ListQuery } from '../contracts/storage.js';
import { createMcpConnectionStore } from '../modules/mcp/connections.js';
import { isJevConnectionId, jevConnectionIdForOwner, jevMcpServerConfig, JEV_BROWSER_MCP_COMMAND, JEV_BROWSER_MCP_WRAPPER } from './jev-browser-mcp.js';

function docId(doc: unknown): unknown {
  if (typeof doc !== 'object' || doc === null) return undefined;
  return Reflect.get(doc, 'id');
}

export function hideJevStore(store: Store): Store {
  const hidden: Store = {
    forOwner: store.forOwner === undefined ? undefined : (ownerId: string) => hideJevStore(store.forOwner!(ownerId)),
    tx: <T>(fn: (inner: Store) => Promise<T>) => store.tx((inner) => fn(hideJevStore(inner))),
    get: <C extends Collection>(collection: C, id: string) => {
      if (collection === 'connections' && isJevConnectionId(id)) return Promise.resolve(null);
      return store.get(collection, id);
    },
    list: <C extends Collection>(collection: C, query?: ListQuery) => store.list(collection, query).then((page: ListPage<Doc<C>>) => {
      if (collection !== 'connections') return page;
      return { items: page.items.filter((doc) => !isJevConnectionId(docId(doc))), nextCursor: page.nextCursor };
    }),
    put: <C extends Collection>(collection: C, doc: Doc<C>, index?: IndexedFields) => store.put(collection, doc, index),
    patch: <C extends Collection>(collection: C, id: string, patch: Partial<Doc<C>>) => store.patch(collection, id, patch),
    delete: (collection: Collection, id: string) => {
      if (collection === 'connections' && isJevConnectionId(id)) return Promise.resolve();
      return store.delete(collection, id);
    },
    emit: (event: AgentEvent) => store.emit(event),
  };
  if (store.getForUpdate === undefined) return hidden;
  const locked = store.getForUpdate.bind(store);
  return {
    ...hidden,
    getForUpdate: <C extends Collection>(collection: C, id: string) => {
      if (collection === 'connections' && isJevConnectionId(id)) return Promise.resolve(null);
      return locked(collection, id);
    },
  };
}

function readString(doc: unknown, key: string): string | undefined {
  if (typeof doc !== 'object' || doc === null) return undefined;
  const value: unknown = Reflect.get(doc, key);
  return typeof value === 'string' ? value : undefined;
}

function isCanonicalManagedRow(doc: unknown, ownerId: string): boolean {
  if (typeof doc !== 'object' || doc === null) return false;
  const args: unknown = Reflect.get(doc, 'args');
  return readString(doc, 'kind') === 'mcp'
    && readString(doc, 'ownerId') === ownerId
    && readString(doc, 'transport') === 'stdio'
    && readString(doc, 'endpoint') === JEV_BROWSER_MCP_COMMAND
    && Array.isArray(args) && args.length === 1 && args[0] === JEV_BROWSER_MCP_WRAPPER;
}

export async function ensureJevConnection(store: Store, ownerId: string): Promise<boolean> {
  const id = jevConnectionIdForOwner(ownerId);
  const existing = await store.get('connections', id).catch(() => null);
  if (existing !== null) return isCanonicalManagedRow(existing, ownerId);
  await createMcpConnectionStore(store).save(ownerId, id, 'Jev Browser', jevMcpServerConfig(), { state: 'disconnected' });
  return true;
}

/** The `agentHome` mirror (BACKEND §5.2): an index and backup of the files in the user's computer. */
import type { Store } from '../../contracts/index.js';
import type { AgentHomeRow } from '../../contracts/storage.js';
import { listAll } from '../memory/util.js';
import { agentIdOfPath, homeHash } from './paths.js';

export const rowId = (ownerId: string, path: string): string => ownerId + ':' + path;

export function newRow(ownerId: string, path: string, content: string, writer: AgentHomeRow['writer'], updatedAt: string, pendingWrite = false): AgentHomeRow {
  const agentId = agentIdOfPath(path);
  return {
    id: rowId(ownerId, path), ownerId, path, content, hash: homeHash(content), writer, updatedAt,
    ...(agentId === undefined ? {} : { agentId }),
    ...(pendingWrite ? { pendingWrite: true } : {}),
  };
}

/** Rows carry an index kind so "the user's shared files" is a query: `shared` (no agent) or `agent`. */
export function putRow(store: Store, row: AgentHomeRow): Promise<AgentHomeRow> {
  return store.put('agentHome', row, { agentId: row.agentId ?? null, kind: row.agentId === undefined ? 'shared' : 'agent' });
}

export const deleteRow = (store: Store, ownerId: string, path: string): Promise<void> => store.delete('agentHome', rowId(ownerId, path));

export const getRow = (store: Store, ownerId: string, path: string): Promise<AgentHomeRow | null> => store.get('agentHome', rowId(ownerId, path));

/** The owner's shared rows and one agent's rows, by path. Rows of other owners never match (the store is owner scoped). */
export async function readRows(store: Store, ownerId: string, agentId: string): Promise<Map<string, AgentHomeRow>> {
  const [shared, own] = await Promise.all([
    listAll(store, 'agentHome', { where: { kind: 'shared' } }),
    listAll(store, 'agentHome', { where: { agentId } }),
  ]);
  return new Map([...shared, ...own].filter((row) => row.ownerId === ownerId).map((row) => [row.path, row]));
}

/** Every row of the owner whose path starts with `prefix`: the files page lists the mirror, never the computer. */
export async function readRowsUnder(store: Store, ownerId: string, prefix: string): Promise<AgentHomeRow[]> {
  return (await listAll(store, 'agentHome')).filter((row) => row.ownerId === ownerId && row.path.startsWith(prefix));
}

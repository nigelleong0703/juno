/**
 * Undo for an agent's file writes (BACKEND 5.2d). Before `files.write` / `files.edit` replaces a file on the agent's sandbox or the owner's Mac,
 * the old text is kept: the bytes in the blob store (S3 on the server, a local directory on the desktop; never in Postgres), a row of metadata
 * beside them. The last 20 per path and 14 days are kept, pruned on every write. `restoreSnapshot` puts a kept version back and keeps what it
 * replaced, so a restore can itself be undone. A shell command, `computer_copy` and a file that is not UTF-8 text are not covered.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { FileSnapshot, FileSnapshotTool, FileHistoryComputer } from '@agent-desktop/public-contracts';
import { loadBlob, saveBlob, type BlobStore } from '../../contracts/blobs.js';
import type { FileSnapshotRow, Store } from '../../contracts/storage.js';
import type { ComputerClient } from '../../ports/computer/index.js';

export const SNAPSHOTS_PER_PATH = 20;
export const SNAPSHOT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** A bigger file is replaced without a copy (and the tool says so): this is a safety net for text, not a backup of data. */
export const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;

const MIME = 'text/plain; charset=utf-8';
/** What a failed read of a missing file says, on the sandbox (`cat`) and on the Mac. */
const MISSING = /no such file|not.?found|enoent|does not exist/i;

export type FileHistoryErrorCode = 'NOT_FOUND' | 'UNAVAILABLE' | 'TOO_LARGE' | 'FAILED';

export class FileHistoryError extends Error {
  readonly status: 404 | 409 | 413 | 500;
  constructor(readonly code: FileHistoryErrorCode, message: string) {
    super(message);
    this.name = 'FileHistoryError';
    this.status = code === 'NOT_FOUND' ? 404 : code === 'UNAVAILABLE' ? 409 : code === 'TOO_LARGE' ? 413 : 500;
  }
}

export interface HistoryDeps {
  store: Store;
  blobs: BlobStore;
}

/** Who made the write: the agent, and the run and durable step it came from. */
export interface WriteOrigin {
  agentId: string;
  runId?: string;
  conversationId?: string;
  stepId?: string;
}

export interface FileTarget {
  path: string;
  on: FileHistoryComputer;
}

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The key one path's history is stored and read under. Per agent: two agents that write the same shared file each keep their own. */
export const pathKeyOf = (agentId: string, target: FileTarget): string => sha(`${agentId}\0${target.on}\0${target.path}`);

const publicSnapshot = ({ blobKey: _blobKey, parentId: _parentId, ...snapshot }: FileSnapshotRow): FileSnapshot => snapshot;

const expired = (row: Pick<FileSnapshotRow, 'createdAt'>, now: number): boolean => now - Date.parse(row.createdAt) > SNAPSHOT_RETENTION_MS;

async function rowsOfPath(store: Store, key: string): Promise<FileSnapshotRow[]> {
  const rows: FileSnapshotRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list('fileSnapshots', { where: { parentId: key }, limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    rows.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/** Drop what is beyond the last 20 or older than 14 days. The bytes stay in the blob store (content-addressed, possibly shared; BACKEND 5.2a). */
async function prune(store: Store, rows: readonly FileSnapshotRow[], now: number): Promise<void> {
  for (const [index, row] of rows.entries()) {
    if (index >= SNAPSHOTS_PER_PATH || expired(row, now)) await store.delete('fileSnapshots', row.id);
  }
}

export type Kept = { kept: FileSnapshotRow } | { skipped: 'too_large' };

/**
 * Keep `previous` (the text a path holds right now) as a snapshot, before the caller replaces it. The id comes from the durable step, so a
 * retried call rewrites its own row. Throws when the blob store or the database fails: the caller then does not write.
 */
export async function keepPreviousVersion(
  deps: HistoryDeps,
  origin: WriteOrigin,
  target: FileTarget,
  tool: FileSnapshotTool,
  previous: string,
  restoredFrom?: string,
  now: () => number = Date.now,
): Promise<Kept> {
  const bytes = Buffer.from(previous, 'utf8');
  if (bytes.length > MAX_SNAPSHOT_BYTES) return { skipped: 'too_large' };
  const ref = await saveBlob(deps.blobs, bytes, MIME);
  const key = pathKeyOf(origin.agentId, target);
  const earlier = await rowsOfPath(deps.store, key);
  // Strictly later than the newest kept version of this path, so "newest first" is never a tie between two writes in one millisecond.
  const at = Math.max(now(), earlier[0] === undefined ? 0 : Date.parse(earlier[0].createdAt) + 1);
  const row: FileSnapshotRow = {
    id: origin.stepId === undefined ? `fsn_${randomUUID()}` : `fsn_${sha(`${origin.stepId}\0${tool}\0${key}`).slice(0, 32)}`,
    agentId: origin.agentId,
    path: target.path,
    on: target.on,
    tool,
    ...(origin.runId === undefined ? {} : { runId: origin.runId }),
    ...(origin.conversationId === undefined ? {} : { conversationId: origin.conversationId }),
    ...(origin.stepId === undefined ? {} : { stepId: origin.stepId }),
    sizeBytes: ref.sizeBytes,
    sha256: ref.sha256,
    ...(restoredFrom === undefined ? {} : { restoredFrom }),
    createdAt: new Date(at).toISOString(),
    blobKey: ref.blobKey,
    parentId: key,
  };
  await deps.store.put('fileSnapshots', row);
  await prune(deps.store, [row, ...earlier.filter((kept) => kept.id !== row.id)], now());
  return { kept: row };
}

/** The kept versions of one path of one agent, newest first (the ones past 14 days are not offered even before a write prunes them). */
export async function historyOf(deps: HistoryDeps, agentId: string, target: FileTarget, now: () => number = Date.now): Promise<FileSnapshot[]> {
  const rows = await rowsOfPath(deps.store, pathKeyOf(agentId, target));
  return rows.filter((row) => !expired(row, now())).slice(0, SNAPSHOTS_PER_PATH).map(publicSnapshot);
}

/**
 * The text a path holds now, or undefined when there is nothing worth keeping: no file, an empty one (replacing it loses nothing), or one
 * that is not valid UTF-8 text (the decoded string is not the file, so a copy would not be faithful; the write still goes ahead).
 * Any other failure (computer down, user in control) is not "nothing": it is rethrown.
 */
export async function currentText(computer: ComputerClient, agentId: string, target: FileTarget, signal: AbortSignal): Promise<string | undefined> {
  try {
    const file = await computer.readFile(agentId, target.path, signal, target.on);
    return file.content !== '' && file.bytes === Buffer.byteLength(file.content, 'utf8') ? file.content : undefined;
  } catch (error) {
    if (error instanceof Error && MISSING.test(error.message)) return undefined;
    throw error;
  }
}

export interface Restored {
  restored: FileSnapshot;
  undo?: FileSnapshot;
  path: string;
  on: FileHistoryComputer;
  bytes: number;
}

/**
 * Put a snapshot back. `agentId` limits it to that agent's own snapshots (the agent tool); the owner's route passes none, and the snapshot's
 * agent acts. What is at the path now is kept first (as a `files.restore` snapshot), so this too can be undone.
 */
export async function restoreSnapshot(
  deps: HistoryDeps & { computer: ComputerClient },
  input: { snapshotId: string; agentId?: string; origin: Omit<WriteOrigin, 'agentId'>; signal: AbortSignal; now?: () => number },
): Promise<Restored> {
  const now = input.now ?? Date.now;
  const row = await deps.store.get('fileSnapshots', input.snapshotId);
  if (row === null || (input.agentId !== undefined && row.agentId !== input.agentId) || expired(row, now())) {
    throw new FileHistoryError('NOT_FOUND', 'No such earlier version: it may be older than 14 days or pushed out by newer ones.');
  }
  const loaded = await loadBlob(deps.blobs, row);
  if (!loaded.ok) throw new FileHistoryError('FAILED', `The saved version could not be read: ${loaded.reason}.`);
  const target: FileTarget = { path: row.path, on: row.on };
  const origin: WriteOrigin = { ...input.origin, agentId: row.agentId };
  const before = await currentText(deps.computer, row.agentId, target, input.signal).catch((error: unknown) => {
    throw new FileHistoryError('UNAVAILABLE', `Could not read ${row.path} on the ${row.on === 'mac' ? 'Mac' : 'sandbox'}: ${error instanceof Error ? error.message : String(error)}`);
  });
  let undo: FileSnapshot | undefined;
  if (before !== undefined) {
    const kept = await keepPreviousVersion(deps, origin, target, 'files.restore', before, row.id, now);
    if ('skipped' in kept) throw new FileHistoryError('TOO_LARGE', `${row.path} is too large to keep a copy of, so it was not replaced.`);
    undo = publicSnapshot(kept.kept);
  }
  const written = await deps.computer.writeFile(row.agentId, { path: row.path, content: loaded.bytes.toString('utf8') }, input.signal, row.on).catch((error: unknown) => {
    throw new FileHistoryError('UNAVAILABLE', `Could not write ${row.path}: ${error instanceof Error ? error.message : String(error)}`);
  });
  return { restored: publicSnapshot(row), ...(undo === undefined ? {} : { undo }), path: row.path, on: row.on, bytes: written.bytes };
}

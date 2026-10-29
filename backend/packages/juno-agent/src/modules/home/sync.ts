/**
 * The four sync rules of BACKEND §5.2 as a pure plan: what to write to the computer, what to pull into the mirror,
 * what to drop, and what to audit. The service (service.ts) runs the plan; nothing here does I/O.
 */
import type { HomeSnapshot } from '../../ports/computer/index.js';
import type { AgentHomeRow } from '../../contracts/storage.js';
import { SYNC_MARKER, isProtectedPath } from './paths.js';

export interface SyncInput {
  snapshot: HomeSnapshot;
  /** Mirror rows in scope (the user's shared files and this agent's), keyed by path, after the platform refreshed its own rows. */
  rows: ReadonlyMap<string, AgentHomeRow>;
  /** Rows the platform just rewrote (a changed skill, docs): the computer catching up is not tampering. */
  platformUpdated: ReadonlySet<string>;
  /** Rows the platform just removed (a deselected skill): the file goes from the computer too. */
  platformRemoved: ReadonlySet<string>;
}

export interface SyncPlan {
  /** Mirror rows to write to the computer: rule 1 (pending), rule 2 (a new computer) and rule 4 (restore). */
  write: string[];
  /** Files to delete from the computer: strays in protected places and removed platform files. */
  remove: string[];
  /** Files the agent changed or added: read them into the mirror (rule 3). */
  pull: string[];
  /** Mirror rows whose file is gone from the computer (rule 3). */
  dropRows: string[];
  /** Rows whose `pendingWrite` clears once their write lands (rule 1). */
  clearPending: string[];
  /** Protected files found changed or missing, restored from the mirror (rule 4): audit each. */
  reverted: Array<{ path: string; before: string | undefined; after: string | undefined }>;
  /** Write `.juno-sync` after the writes (rule 2). */
  marker: boolean;
}

export function planSync(input: SyncInput): SyncPlan {
  const { snapshot, rows } = input;
  const plan: SyncPlan = { write: [], remove: [], pull: [], dropRows: [], clearPending: [], reverted: [], marker: false };
  const pending = [...rows.values()].filter((row) => row.pendingWrite === true).map((row) => row.path);
  plan.clearPending = pending;

  // Rule 2: a computer without the marker is new or reset (or predates durable storage, BACKEND 7.10); the mirror goes back,
  // except files the computer already has: when the storage holds them they are the newer truth, and the next sync (now with
  // the marker) compares them with the mirror by the normal rules.
  if (!snapshot.synced) {
    const present = new Set(snapshot.files.map((file) => file.path));
    plan.write = [...rows.keys()].filter((path) => !present.has(path));
    plan.marker = true;
    return plan;
  }

  // Rule 1 first: pending rows land on the computer, so below they count as present with the mirror's hash.
  const onComputer = new Map(snapshot.files.filter((file) => file.path !== SYNC_MARKER).map((file) => [file.path, file.hash]));
  plan.write.push(...pending);
  for (const path of pending) {
    const row = rows.get(path);
    if (row !== undefined) onComputer.set(path, row.hash);
  }
  const flushed = new Set(pending);

  for (const [path, hash] of onComputer) {
    if (flushed.has(path)) continue;
    const row = rows.get(path);
    if (input.platformRemoved.has(path)) {
      plan.remove.push(path);
    } else if (isProtectedPath(path)) {
      // Rule 4: not written through the platform, so put the mirror's version back (or drop a stray).
      if (row === undefined) {
        plan.remove.push(path);
        plan.reverted.push({ path, before: hash, after: undefined });
      } else if (row.hash !== hash) {
        plan.write.push(path);
        if (!input.platformUpdated.has(path)) plan.reverted.push({ path, before: hash, after: row.hash });
      }
    } else if (row === undefined || row.hash !== hash) {
      plan.pull.push(path);
    }
  }

  for (const [path, row] of rows) {
    if (onComputer.has(path) || input.platformRemoved.has(path)) continue;
    if (isProtectedPath(path)) {
      plan.write.push(path);
      if (!input.platformUpdated.has(path)) plan.reverted.push({ path, before: undefined, after: row.hash });
    } else {
      plan.dropRows.push(path);
    }
  }
  return plan;
}

/**
 * What an agent added to a file since `base`: the tail when it appended (the normal case), else the lines that are new when it
 * rewrote the whole file. Used to move a teammate's daily-log lines out of the creator's computer (BACKEND §5.7.1).
 */
export function appendedText(base: string, current: string): string {
  if (current.startsWith(base)) return current.slice(base.length);
  const known = new Set(base.split('\n'));
  return current.split('\n').filter((line) => line.trim().length > 0 && !known.has(line)).join('\n') + '\n';
}

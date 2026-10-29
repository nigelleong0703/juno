/**
 * The harness versions in the database (migration 0053) and what a session reads (BACKEND §11.2, H1a).
 * Boot: the repository seed is compiled (startup fails when it is invalid), its id is looked up, and when it is new it becomes the
 * active version (the previous active one is retired). A session pins the version its frozen system row names; a pinned version
 * other than the active one is read once from the store and kept in a small LRU.
 */
import { compileHarnessVersion, HarnessError, harnessSeedVersion, setActiveHarnessVersion, activeHarnessVersion, type HarnessOrigin, type HarnessVersion } from './loader.js';

export type HarnessStatus = 'candidate' | 'active' | 'retired';

export interface HarnessVersionRow {
  id: string;
  parentId: string | null;
  files: Record<string, string>;
  origin: HarnessOrigin;
  status: HarnessStatus;
  note: string;
  createdAt: string;
}

export interface HarnessVersionStore {
  row(id: string): Promise<HarnessVersionRow | undefined>;
  active(): Promise<HarnessVersionRow | undefined>;
  /**
   * Make the seed version the active one: an existing row with its id becomes active, otherwise it is inserted as `seed`. The previous
   * active row and any candidate are retired in the same transaction.
   */
  seedActive(version: HarnessVersion): Promise<HarnessVersionRow>;
}

const LRU_CAPACITY = 16;

/**
 * Pinned versions read from the store by id (the active version is never cached here: it is the process's own). With no store (the
 * in-memory store) every session reads the active version, which is the repository seed.
 */
export class HarnessPins {
  private readonly cache = new Map<string, HarnessVersion>();

  constructor(private readonly store?: HarnessVersionStore) {}

  /** The version a session reads: its pinned id, or the active version when the session has no pin yet. */
  async resolve(pinnedId: string | undefined): Promise<HarnessVersion> {
    const active = activeHarnessVersion();
    if (pinnedId === undefined || pinnedId === active.id || this.store === undefined) return active;
    const cached = this.cache.get(pinnedId);
    if (cached !== undefined) {
      this.cache.delete(pinnedId);
      this.cache.set(pinnedId, cached);
      return cached;
    }
    const row = await this.store.row(pinnedId);
    if (row === undefined) throw new HarnessError(`harness version ${pinnedId} is pinned by a session but not in the store`);
    const version = compileHarnessVersion(row.files);
    this.cache.set(pinnedId, version);
    if (this.cache.size > LRU_CAPACITY) this.cache.delete(this.cache.keys().next().value ?? '');
    return version;
  }
}

/**
 * Boot: seed the store from the repository and make its active row the process's version. Called once per process start under the
 * instance lock (agentd's boot). Returns the active row.
 */
export async function bootHarnessVersions(store: HarnessVersionStore): Promise<HarnessVersionRow> {
  const seed = harnessSeedVersion();
  const row = await store.seedActive(seed);
  setActiveHarnessVersion(compileHarnessVersion(row.files));
  return row;
}

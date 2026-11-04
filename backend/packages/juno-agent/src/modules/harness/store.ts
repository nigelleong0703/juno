/**
 * The harness versions in the database (migration 0053) and what a session reads (BACKEND §11.2, H1a).
 * Boot: the repository seed is compiled (startup fails when it is invalid), its id is looked up, and when it is new it becomes the
 * active version (the previous active one is retired). A session pins the version its frozen system row names; a pinned version
 * other than the active one is read once from the store and kept in a small LRU.
 */
import { compileHarnessVersion, HarnessError, harnessSeedVersion, parseUnitFile, setActiveHarnessVersion, activeHarnessVersion, type HarnessOrigin, type HarnessUnit, type HarnessVersion } from './loader.js';

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
  /** The harness versions sessions are pinned to (the frozen system rows' `contextMeta.harnessVersion`), with how many sessions each. */
  pinnedVersions(): Promise<{ id: string; sessions: number }[]>;
  /**
   * Make the seed version the active one: an existing row with its id becomes active, otherwise it is inserted as `seed`. The previous
   * active row and any candidate are retired in the same transaction.
   */
  seedActive(version: HarnessVersion): Promise<HarnessVersionRow>;
}

const LRU_CAPACITY = 16;

export interface PinnedUpgrade {
  /** The session's effective version: always compiles, because every unit is either its own valid one or the active one. */
  version: HarnessVersion;
  /** Units taken from the active version because the pinned row lacks them, cannot parse them, or declares other placement / vars. */
  upgraded: string[];
  /** Units in the pinned row that the code no longer has. */
  dropped: string[];
}

/**
 * The version a session pinned to `pinnedFiles` reads now: for every unit the current code needs (the active version's ids, tools
 * included) the pinned file when it parses and declares the same placement and vars as the active unit, else the active file.
 */
export function upgradePinnedVersion(pinnedFiles: Readonly<Record<string, string>>, active: HarnessVersion): PinnedUpgrade {
  const files: Record<string, string> = {};
  const upgraded: string[] = [];
  for (const [id, unit] of active.units) {
    const own = pinnedFiles[id];
    if (own !== undefined && sameShape(own, unit)) files[id] = own;
    else {
      files[id] = active.files[id] ?? '';
      upgraded.push(id);
    }
  }
  const dropped = Object.keys(pinnedFiles).filter((id) => !active.units.has(id));
  return { version: compileHarnessVersion(files), upgraded, dropped };
}

function sameShape(raw: string, wanted: HarnessUnit): boolean {
  try {
    const unit = parseUnitFile(raw, wanted.id);
    return unit.placement === wanted.placement && [...unit.vars].sort().join(',') === [...wanted.vars].sort().join(',');
  } catch (error) {
    if (error instanceof HarnessError) return false;
    throw error;
  }
}

/**
 * Pinned versions read from the store by id (the active version is never cached here: it is the process's own). With no store (the
 * in-memory store) every session reads the active version, which is the repository seed.
 */
export class HarnessPins {
  private readonly cache = new Map<string, HarnessVersion>();

  constructor(private readonly store?: HarnessVersionStore, private readonly log?: (fields: Record<string, unknown>, message: string) => void) {}

  /**
   * The version a session reads: its pinned id, or the active version when the session has no pin yet. The pinned row is upgraded per
   * unit (upgradePinnedVersion): a unit the session's version has and this code still reads the same way keeps the session's own text
   * (its cached prefix stays byte-identical); a unit it lacks, or whose placeholders changed, takes the active text; a unit the code no
   * longer has is dropped. Without that, a long-lived session (a routine's chat) fails every run after a deploy that adds a unit.
   * A pinned id that is not in the store reads the active version.
   */
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
    if (row === undefined) {
      this.log?.({ pinnedId, activeId: active.id }, 'harness version pinned by a session is not in the store; reading the active version');
      return active;
    }
    const version = upgradePinnedVersion(row.files, active).version;
    this.cache.set(pinnedId, version);
    if (this.cache.size > LRU_CAPACITY) this.cache.delete(this.cache.keys().next().value ?? '');
    return version;
  }
}

/**
 * Boot: seed the store from the repository and make its active row the process's version. Called once per process start under the
 * instance lock (agentd's boot). Returns the active row.
 */
export async function bootHarnessVersions(store: HarnessVersionStore, log?: (fields: Record<string, unknown>, message: string) => void): Promise<HarnessVersionRow> {
  const seed = harnessSeedVersion();
  const row = await store.seedActive(seed);
  const active = compileHarnessVersion(row.files);
  setActiveHarnessVersion(active);
  await logPinnedUpgrades(store, active, log);
  return row;
}

/**
 * The guard against a silent break: log, per harness version that sessions are still pinned to, how many units it lacks or no longer
 * shares with this code and how many are left over, and that they are upgraded per unit. Never fails the boot.
 */
export async function logPinnedUpgrades(store: HarnessVersionStore, active: HarnessVersion, log?: (fields: Record<string, unknown>, message: string) => void): Promise<void> {
  try {
    for (const { id, sessions } of await store.pinnedVersions()) {
      if (id === active.id) continue;
      const row = await store.row(id);
      if (row === undefined) {
        log?.({ version: id, sessions }, 'harness pins upgraded: pinned version is not in the store, those sessions read the active version');
        continue;
      }
      const { upgraded, dropped } = upgradePinnedVersion(row.files, active);
      log?.({ version: id, sessions, upgradedUnits: upgraded.length, droppedUnits: dropped.length, upgraded: upgraded.slice(0, 20), dropped: dropped.slice(0, 20) }, 'harness pins upgraded');
    }
  } catch (error) {
    log?.({ err: error instanceof Error ? error.message : String(error) }, 'harness pins could not be listed');
  }
}

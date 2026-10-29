import type { ListParams, ListResult, SortOrder } from '@agent-desktop/client';

// ---------------------------------------------------------------------------
// Seeded RNG (deterministic world building + simulation)
// ---------------------------------------------------------------------------

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  /** Random element; throws on an empty array. */
  pick<T>(items: readonly T[]): T;
  bool(probability?: number): boolean;
  /** Sample `count` distinct elements (or all, if count exceeds length). */
  sample<T>(items: readonly T[], count: number): T[];
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const pick = <T,>(items: readonly T[]): T => {
    const value = items[int(0, items.length - 1)];
    if (value === undefined) throw new Error('rng.pick: empty collection');
    return value;
  };
  const sample = <T,>(items: readonly T[], count: number): T[] => {
    const pool = items.slice();
    const out: T[] = [];
    const n = Math.min(count, pool.length);
    for (let i = 0; i < n; i += 1) {
      const idx = int(0, pool.length - 1);
      const [taken] = pool.splice(idx, 1);
      if (taken !== undefined) out.push(taken);
    }
    return out;
  };
  return { next, int, pick, bool: (p = 0.5) => next() < p, sample };
}

/** Assertive array access, safe under `noUncheckedIndexedAccess`. */
export function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`index ${index} out of range`);
  return value;
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export type NowFn = () => number;

export const systemNow: NowFn = () => Date.now();

export const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Querying: filter → search → sort → cursor paginate
// ---------------------------------------------------------------------------

export interface QuerySpec<T> {
  params?: ListParams;
  predicate?: (item: T) => boolean;
  searchText?: (item: T) => string;
  defaultSort?: { key: string; order: SortOrder };
}

function getPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

const encodeCursor = (offset: number): string => `c_${offset}`;

const decodeCursor = (cursor: string | null | undefined): number => {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor.replace(/^c_/, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

export function paginate<T>(all: readonly T[], spec: QuerySpec<T> = {}): ListResult<T> {
  const params = spec.params ?? {};
  let rows = all.slice();
  if (spec.predicate) rows = rows.filter(spec.predicate);
  if (params.filter) {
    for (const [key, value] of Object.entries(params.filter)) {
      const wanted = Array.isArray(value) ? value : [value];
      rows = rows.filter((row) => wanted.includes(String(getPath(row, key))));
    }
  }
  if (params.search && spec.searchText) {
    const needle = params.search.toLowerCase();
    const text = spec.searchText;
    rows = rows.filter((row) => text(row).toLowerCase().includes(needle));
  }
  const sortKey = params.sort ?? spec.defaultSort?.key;
  const order: SortOrder = params.order ?? spec.defaultSort?.order ?? 'desc';
  if (sortKey) {
    const dir = order === 'asc' ? 1 : -1;
    rows.sort((a, b) => compare(getPath(a, sortKey), getPath(b, sortKey)) * dir);
  }
  const limit = params.limit ?? 50;
  const offset = decodeCursor(params.cursor);
  // Copies, like a real HTTP response: handing out the live rows lets a later in-place update mutate
  // what the caller already cached, so its refetch looks unchanged and the UI never re-renders.
  const items = rows.slice(offset, offset + limit).map((row) => ({ ...row }));
  const nextOffset = offset + items.length;
  return { items, nextCursor: nextOffset < rows.length ? encodeCursor(nextOffset) : null };
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Stable, collision-free id generator for entities created after boot. */
export function createIdFactory(prefix: string, rng: Rng): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    const suffix = rng.int(1000, 9999);
    return `${prefix}_${counter.toString(36)}${suffix.toString(36)}`;
  };
}

export function upsertById<T extends { id: string }>(rows: T[], next: T): T {
  const index = rows.findIndex((row) => row.id === next.id);
  if (index >= 0) rows[index] = next;
  else rows.push(next);
  return next;
}

export function removeById<T extends { id: string }>(rows: T[], id: string): boolean {
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) return false;
  rows.splice(index, 1);
  return true;
}

export function mustFind<T extends { id: string }>(rows: readonly T[], id: string, what: string): T {
  const found = rows.find((row) => row.id === id);
  if (!found) throw new Error(`${what} not found: ${id}`);
  return found;
}

/** An error shaped like the HTTP client's `HttpError`, so mock and http callers branch on the same `status`/`code`. */
export function apiError(status: number, code: string, message: string): Error & { status: number; code: string } {
  return Object.assign(new Error(message), { name: 'HttpError', status, code });
}

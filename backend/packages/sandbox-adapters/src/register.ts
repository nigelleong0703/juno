/**
 * The display registry: which agent owns which display on the shared VM.
 *
 * Rules from BACKEND §7.1 live here, because this component alone sees every screen:
 *  - at most \`MAX_LIVE_SCREENS\` displays are live;
 *  - an agent keeps its display while it holds one (its Chromium profile is keyed by agent, so a
 *    return after eviction still finds its logins), and display numbers are reused, never grown;
 *  - a taken-over (user-controlled) screen is \`pinned\` and is never the eviction victim.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { failed } from './errors.js';

export interface PoolEntry {
  displayNo: number;
  agentId: string;
  lastUsedAt: number;
  /** Held by the user: not evictable. */
  pinned?: boolean;
}

export interface PoolLease {
  displayNo: number;
  /** An agent that lost its display to the cap; its screen must be stopped. */
  evicted: PoolEntry | null;
  /** True when this call created a new holder (so the pool changed and must be persisted). */
  created: boolean;
}

export interface ScreenPool {
  lease(agentId: string): PoolLease;
  /** Advance \`lastUsedAt\` so an active agent is not the eviction candidate. */
  touch(agentId: string): void;
  pin(agentId: string): void;
  unpin(agentId: string): void;
  release(agentId: string): void;
  entries(): PoolEntry[];
}

export function createScreenPool(maxLive: number, seed: PoolEntry[] = []): ScreenPool {
  const holders = new Map<string, PoolEntry>();
  for (const entry of seed) holders.set(entry.agentId, entry);

  /** The smallest display number not currently held; reuses freed numbers so the VM stays bounded. */
  const freeDisplay = (): number => {
    const used = new Set([...holders.values()].map((entry) => entry.displayNo));
    let candidate = 1;
    while (used.has(candidate)) candidate += 1;
    return candidate;
  };

  return {
    lease(agentId) {
      const existing = holders.get(agentId);
      if (existing) {
        existing.lastUsedAt = Date.now();
        return { displayNo: existing.displayNo, evicted: null, created: false };
      }
      if (holders.size < maxLive) {
        const created: PoolEntry = { displayNo: freeDisplay(), agentId, lastUsedAt: Date.now() };
        holders.set(agentId, created);
        return { displayNo: created.displayNo, evicted: null, created: true };
      }
      const victim = [...holders.values()]
        .filter((entry) => !entry.pinned)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!victim) {
        throw failed(`all ${maxLive} screens are held by the user; release one before starting another`);
      }
      holders.delete(victim.agentId);
      const created: PoolEntry = { displayNo: victim.displayNo, agentId, lastUsedAt: Date.now() };
      holders.set(agentId, created);
      return { displayNo: created.displayNo, evicted: victim, created: true };
    },

    touch(agentId) {
      const existing = holders.get(agentId);
      if (existing) existing.lastUsedAt = Date.now();
    },

    pin(agentId) {
      const existing = holders.get(agentId);
      if (existing) existing.pinned = true;
    },

    unpin(agentId) {
      const existing = holders.get(agentId);
      if (existing) delete existing.pinned;
    },

    release(agentId) {
      holders.delete(agentId);
    },

    entries() {
      return [...holders.values()].sort((a, b) => a.displayNo - b.displayNo);
    },
  };
}

/** Persist the pool so a channel restart keeps each agent on its own display. */
export function loadPool(file: string): PoolEntry[] {
  if (!file) return [];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return [];
    throw failed(`could not read the screen pool ${file}: ${message(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw failed(`screen pool ${file} is corrupt; refusing to start (agents could land on the wrong display)`);
  }
  if (!Array.isArray(parsed)) throw failed(`screen pool ${file} is not a list`);
  return parsed.flatMap((item) => (isEntry(item) ? [item] : []));
}

export function savePool(file: string, entries: PoolEntry[]): void {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(entries));
    renameSync(temp, file);
  } catch (error) {
    throw failed(`could not persist the screen pool to ${file}: ${message(error)}`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEntry(value: unknown): value is PoolEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const holder: { displayNo?: unknown; agentId?: unknown; lastUsedAt?: unknown; pinned?: unknown } = value;
  return (
    typeof holder.displayNo === 'number' &&
    typeof holder.agentId === 'string' &&
    typeof holder.lastUsedAt === 'number' &&
    (holder.pinned === undefined || typeof holder.pinned === 'boolean')
  );
}

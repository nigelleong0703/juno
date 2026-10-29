/**
 * The Store implementations the shared suites run against: memory, and Postgres on one embedded cluster per test
 * file (started on first use; `closeScratchPostgres` in afterAll stops it).
 */
import { randomUUID } from 'node:crypto';
import type { EventBus, Store } from '@agent-desktop/contracts';
import { createMemoryStore } from '../memory-store.js';
import { createPostgresStore } from '../postgres-store.js';
import { startScratchPostgres, type ScratchPostgres } from './scratch-postgres.js';

export type TestStore = Store & { eventBus: EventBus; probe?(signal: AbortSignal): Promise<void> };

export interface Backend {
  name: 'memory' | 'postgres';
  /** A fresh store; `close` releases it. */
  open(): Promise<{ store: TestStore; close(): Promise<void> }>;
}

let scratch: Promise<ScratchPostgres> | undefined;

/** The URL of this test file's Postgres (started on first call). */
export function scratchPostgresUrl(): Promise<string> {
  scratch ??= startScratchPostgres();
  return scratch.then((cluster) => cluster.url);
}

export async function closeScratchPostgres(): Promise<void> {
  const started = scratch;
  scratch = undefined;
  if (started) await (await started).close();
}

export const backends: Backend[] = [
  { name: 'memory', open: async () => ({ store: createMemoryStore(), close: async () => undefined }) },
  { name: 'postgres', open: async () => {
    const store = await createPostgresStore(await scratchPostgresUrl());
    return { store, close: () => store.close() };
  } },
];

/** Unique per call: Postgres keeps rows between runs, so fixtures never reuse ids. */
export const uid = (prefix: string): string => prefix + '-' + randomUUID().slice(0, 8);

/** Poll until `check` stops throwing: live delivery is immediate in memory and asynchronous elsewhere. */
export async function eventually(check: () => void, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return check(); } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

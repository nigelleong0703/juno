/**
 * Database abstraction layer.
 * Exports Store implementations (memory for tests, Postgres for servers) and a noop enqueuer for testing.
 */

import { createMemoryStore } from './memory-store.js';
import { createPostgresStore } from './postgres-store.js';
import type { EventBus, Store } from '@agent-desktop/contracts';
import type { DurableDb } from '@agent-desktop/durable';

export { createMemoryStore };
export { createMemoryBlobStore } from './memory-store.js';
export { UNKNOWN_OWNER, ownerCollisionMessage, resolveEventOwner, docOwnerId } from './owner-events.js';
export { createPostgresStore };
export { createBlobStore, createLocalBlobStore, createS3BlobStore, deleteS3Prefix, type S3BlobSettings } from './blobs.js';
export { blobKeysUsedByOthers, closeAuthAccount, deleteAuthUser, deleteOwnerEvents, deleteOwnerRows, type AuthClosed } from './owner-erase.js';
export { acquireInstanceLock, type InstanceLock } from './instance-lock.js';
export {
  assertConnectionBudget, plannedConnections, ConnectionBudgetError,
  COORDINATOR_EXTRA_CONNECTIONS, WORKER_EXTRA_CONNECTIONS, DEFAULT_COORDINATOR_POOL, DEFAULT_WORKER_POOL, DEFAULT_API_POOL, DEFAULT_MEMORYD_POOL,
  type ConnectionPlan,
} from './connection-budget.js';

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

  async scheduleCalendarItem(itemId: string): Promise<void> {
    this.calls.push({ method: 'scheduleCalendarItem', args: [itemId] });
  }
}

export type { OwnerLookup } from './owner-events.js';

/** A Store plus its event bus and the lifecycle the processes need (readiness probe, shutdown). */
export type DbStore = Store & {
  eventBus: EventBus;
  /** Raw SQL for the durable runner; absent on the in-memory store. */
  raw?: DurableDb;
  /** Resolves when the database answers; aborting `signal` cancels the query where the driver can. */
  probe(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
};

/**
 * Create a Store: a Postgres URL is Postgres; no URL is the memory store (tests and offline dev).
 */
export async function createStore(databaseUrl: string | undefined, options: { poolMax?: number; idleInTransactionMs?: number } = {}): Promise<DbStore> {
  if (!databaseUrl) {
    return { ...createMemoryStore(), probe: async () => undefined, close: async () => undefined };
  }
  return createPostgresStore(databaseUrl, options);
}

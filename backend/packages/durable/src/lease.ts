/**
 * Lease ownership of one in-flight invocation.
 *
 * A runner claims an invocation with a database-authoritative deadline and a fencing epoch. Everything it writes
 * while executing carries the epoch, and the database rejects the write once the lease has expired or another
 * worker owns the row. The guard is the in-process half: it carries the abort signal cooperative work listens to
 * and it is what the host's store wrapper checks before a business write, so a worker that lost its lease stops
 * writing tool caches and run state at the next boundary instead of racing the new owner to the last row.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DurableDb } from './db.js';

/** What a worker presents when it writes: its identity and the epoch it claimed. */
export interface LeaseFence {
  /** The invocation row this lease covers. */
  id: string;
  service: string;
  key: string;
  owner: string;
  epoch: number;
  laneEpoch: number;
}

/** A write was attempted by a worker that no longer holds the invocation. */
export class LeaseLostError extends Error {
  constructor(reason: string) {
    super(`the invocation lease was lost (${reason}); the new owner continues it`);
    this.name = 'LeaseLostError';
  }
}

export interface LeaseGuard {
  /** The row and tokens this guard proves ownership of. */
  readonly fence: LeaseFence;
  /** Aborted when the lease is lost, so cooperative model/tool work stops early. */
  readonly signal: AbortSignal;
  /** Why the lease was lost, or undefined while this worker still owns the invocation. */
  lost(): string | undefined;
  /** Mark the lease lost once; later calls keep the first reason. */
  lose(reason: string): void;
  /** Throws `LeaseLostError` after the lease was lost; called before every fenced write. */
  assertOwned(): void;
}

const scope = new AsyncLocalStorage<LeaseGuard>();

/** Run `fn` with `guard` as the current invocation's lease (set by the runner around a handler call). */
export function runWithLease<T>(guard: LeaseGuard, fn: () => T): T {
  return scope.run(guard, fn);
}

/** The lease of the invocation whose code is running here, if any. Outside a claim (HTTP, boot jobs) it is undefined. */
export function currentLease(): LeaseGuard | undefined {
  return scope.getStore();
}

/** Throw unless the code running here still owns its lease. A no-op outside a claimed invocation. */
export function assertLease(): void {
  currentLease()?.assertOwned();
}

export function createLeaseGuard(fence: LeaseFence): LeaseGuard {
  const controller = new AbortController();
  let reason: string | undefined;
  return {
    fence,
    signal: controller.signal,
    lost: () => reason,
    lose(next: string): void {
      if (reason !== undefined) return;
      reason = next;
      controller.abort(new LeaseLostError(next));
    },
    assertOwned(): void {
      if (reason !== undefined) throw new LeaseLostError(reason);
    },
  };
}

/**
 * Lock the invocation row and its (service, key) lane (shared) and verify both fences inside the caller's
 * transaction. Holding the locks until commit is what closes the check/write race: a takeover must update one of
 * these very rows, so it waits behind a write that already proved ownership, and a worker whose lease is already
 * gone finds no row and writes nothing.
 *
 * The lane half matters even when the invocation lease is still valid: another invocation on the same key may have
 * taken the lane (its lease expired, or a renewal failed), and the old worker's business write must not land beside
 * it. Callers run this with the same connection/transaction as the business statement.
 *
 * Lock order is part of the contract: invocation row first, then lane row, in every statement that touches both
 * (claim, renew, release, finish and this check). One join with `FOR SHARE OF i, l` leaves the order to the planner,
 * and against a renewal or a finish that updates the two rows in a fixed order it deadlocks (seen with two workers).
 */
export async function assertLeaseRow(tx: DurableDb, fence: LeaseFence): Promise<void> {
  const now = '(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint';
  const invocation = await tx.query(
    `SELECT 1 AS ok FROM invocations
     WHERE id = ? AND status = 'running' AND lease_owner = ? AND epoch = ? AND lease_expires_at > ${now}
     FOR SHARE`,
    [fence.id, fence.owner, fence.epoch],
  );
  if (invocation.length === 0) throw new LeaseLostError('the fence no longer matches the stored lease');
  const lane = await tx.query(
    `SELECT 1 AS ok FROM invocation_lanes
     WHERE service = ? AND key = ? AND owner = ? AND epoch = ? AND expires_at > ${now}
     FOR SHARE`,
    [fence.service, fence.key, fence.owner, fence.laneEpoch],
  );
  if (lane.length === 0) throw new LeaseLostError('the fence no longer matches the stored lease');
}

/**
 * Wrap raw SQL so that every statement a claimed invocation issues runs in a transaction that first locks and
 * verifies its lease row. There is deliberately no read/write classification: a statement's text is not a safety
 * boundary (a `WITH` CTE writes, a leading comment hides the verb, a function call mutates), so reads are fenced
 * too. Anything outside a lease passes through untouched (HTTP, boot jobs, the coordinator).
 */
export function fencedDurableDb(db: DurableDb): DurableDb {
  const alreadyFenced = new AsyncLocalStorage<true>();
  const wrap = (inner: DurableDb): DurableDb => ({
    async query<T extends object>(sql: string, params?: readonly (string | number | null)[]): Promise<T[]> {
      const lease = currentLease();
      if (lease === undefined) return inner.query<T>(sql, params);
      lease.assertOwned();
      if (alreadyFenced.getStore() === true) return inner.query<T>(sql, params);
      return inner.transaction(async (tx) => {
        await assertLeaseRow(tx, lease.fence);
        return alreadyFenced.run(true, () => tx.query<T>(sql, params));
      });
    },
    async transaction<T>(fn: (tx: DurableDb) => Promise<T>): Promise<T> {
      const lease = currentLease();
      if (lease === undefined) return inner.transaction(fn);
      lease.assertOwned();
      if (alreadyFenced.getStore() === true) return inner.transaction(fn);
      return inner.transaction(async (tx) => {
        await assertLeaseRow(tx, lease.fence);
        return alreadyFenced.run(true, () => fn(wrap(tx)));
      });
    },
  });
  const fenced = wrap(db);
  // Listening is not a write: it passes straight through.
  if (db.listen !== undefined) fenced.listen = db.listen.bind(db);
  return fenced;
}

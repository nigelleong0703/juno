/**
 * Postgres-backed Store and EventBus composition.
 * Opens the connection, wires the document store (`documents.ts`) to the event bus
 * (`event-bus.ts`), and exposes the raw `sql` handle.
 */
import { AsyncLocalStorage } from 'async_hooks';
import type { EventBus, Store } from '@agent-desktop/contracts';
import type { Collection, Doc } from '@agent-desktop/contracts';
import { createLogger } from '@agent-desktop/log';
import { openPostgres, type Sql, type TxSql } from './connection.js';
import { createDocStore } from './documents.js';
import { createEventBus } from './event-bus.js';
import { postgresDurableDb } from './durable-db.js';
import { assertLeaseRow, currentLease, fencedDurableDb, type DurableDb } from '@agent-desktop/durable';

const log = createLogger({ service: 'db' });

export type { Sql } from './connection.js';

/**
 * Writes made by a claimed durable invocation run inside one transaction that first locks its invocation row
 * (`FOR SHARE`) and verifies the worker's fence. The lock lives until commit, so a takeover waits behind a write
 * that already proved ownership, and a worker whose lease is gone finds no row and writes nothing. Reads and all
 * writes outside a claim (HTTP, boot jobs, the coordinator) pass through unchanged.
 */
function leaseFencedStore(store: Store, sql: Sql, txContext: AsyncLocalStorage<TxSql>): Store {
  const inTx = (): DurableDb => postgresDurableDb(txContext.getStore() ?? sql);
  const write = <T>(target: Store, fn: () => Promise<T>): Promise<T> => {
    const lease = currentLease();
    if (lease === undefined) return fn();
    lease.assertOwned();
    return target.tx(async () => { await assertLeaseRow(inTx(), lease.fence); return fn(); });
  };
  const guard = (target: Store): Store => {
    const guarded: Store = {
      ...target,
      tx<T>(fn: (inner: Store) => Promise<T>): Promise<T> {
        return target.tx((inner) => fn(guard(inner)));
      },
      put<C extends Collection>(collection: C, doc: Doc<C>, index?: Parameters<Store['put']>[2]): Promise<Doc<C>> {
        return write(target, () => target.put(collection, doc, index));
      },
      patch<C extends Collection>(collection: C, id: string, patch: Partial<Doc<C>>): Promise<Doc<C>> {
        return write(target, () => target.patch(collection, id, patch));
      },
      delete(collection, id): Promise<void> {
        return write(target, () => target.delete(collection, id));
      },
      emit(event): Promise<void> {
        return write(target, () => target.emit(event));
      },
    };
    const forOwner = target.forOwner;
    if (forOwner !== undefined) guarded.forOwner = (ownerId: string) => guard(forOwner.call(target, ownerId));
    return guarded;
  };
  const guarded = guard(store);
  return guarded;
}

export async function createPostgresStore(
  databaseUrl: string,
  options: { poolMax?: number; idleInTransactionMs?: number } = {},
): Promise<Store & { eventBus: EventBus; sql: Sql; raw: DurableDb; close(): Promise<void>; probe(signal: AbortSignal): Promise<void> }> {
  const sql = openPostgres(databaseUrl, {
    ...(options.poolMax === undefined ? {} : { max: options.poolMax }),
    ...(options.idleInTransactionMs === undefined ? {} : { idleInTransactionMs: options.idleInTransactionMs }),
  });
  const txContext = new AsyncLocalStorage<TxSql>();
  let listenerPool: Sql | null = null;

  // The events LISTEN keeps one connection of its own; this pool never runs queries, so it needs no more than that one.
  const getListenerPool = () => {
    if (!listenerPool) {
      listenerPool = openPostgres(databaseUrl, { max: 1 });
    }
    return listenerPool;
  };

  // Test connection
  try {
    await sql`SELECT 1`;
    log.info('Connected to Postgres');
  } catch (error) {
    log.error({ err: error }, 'Failed to connect to Postgres');
    throw error;
  }

  const store = leaseFencedStore(createDocStore({ sql, txContext }), sql, txContext);
  const eventBus = createEventBus({ sql, getListenerPool });

  return {
    ...store,
    eventBus,
    sql,
    raw: fencedDurableDb(postgresDurableDb(sql)),
    close: async () => {
      await listenerPool?.end();
      await sql.end();
    },
    // Readiness probe; aborting issues a real cancel so a hung database does not pile up queries.
    async probe(signal: AbortSignal): Promise<void> {
      const pending = sql.unsafe('SELECT 1');
      const onAbort = (): void => pending.cancel();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        await pending;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

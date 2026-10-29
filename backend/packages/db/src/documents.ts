/**
 * The Postgres document store: CRUD over one table per collection plus the durable event log.
 * Query/projection helpers live in `queries.ts`; live event delivery lives in `event-bus.ts`.
 */
import { type AsyncLocalStorage } from 'async_hooks';
import type {
  Collection,
  Doc,
  IndexedFields,
  ListPage,
  ListQuery,
  Store,
} from '@agent-desktop/contracts';
import { NotFoundError } from '@agent-desktop/contracts';
import type { AgentEvent } from '@agent-desktop/public-contracts';
import type { Queryable, Sql, TxSql } from './connection.js';
import { isDoc, readString, toJsonValue, toRecord } from './guards.js';
import { listPage, projections, tableFor, type DocRow } from './queries.js';
import { ownerCollisionMessage, resolveEventOwner, type OwnerLookup } from './owner-events.js';

/**
 * NOTIFY on the connection the INSERT ran on, so inside a transaction it is delivered at commit.
 * postgres.js's `sql.notify` always runs on the pool (even on a transaction's sql), which fires it
 * before the commit and lets a listener read the event id before the row is visible.
 */
async function notifyEvent(currentSql: Queryable, eventId: number): Promise<void> {
  await currentSql`SELECT pg_notify('events', ${String(eventId)})`;
}

export interface DocStoreOptions {
  sql: Sql;
  txContext: AsyncLocalStorage<TxSql>;
}

/**
 * Owner-scoped Store view (AU2). Every read and write is qualified by owner_id in SQL, before
 * pagination: foreign rows are indistinguishable from missing ones, puts force the scope owner
 * (a cross-owner id conflict fails instead of overwriting), patches can never move a row to
 * another owner, and transactions stay inside the scope.
 */
function scopedStore(args: {
  sql: Sql;
  txContext: AsyncLocalStorage<TxSql>;
  base: Store;
  owner: string;
}): Store {
  const sql = args.sql;
  const txContext = args.txContext;
  const base = args.base;
  const owner = args.owner;
  const scoped: Store = {
    forOwner(next: string): Store {
      return scopedStore({ sql, txContext, base, owner: next });
    },
    async tx<T>(fn: (store: Store) => Promise<T>): Promise<T> {
      return base.tx(() => fn(scoped));
    },
    async get<C extends Collection>(collection: C, id: string): Promise<Doc<C> | null> {
      const currentSql = txContext.getStore() ?? sql;
      const rows = await currentSql<Array<DocRow<Doc<C>>>>`
        SELECT id, owner_id, doc, created_at, updated_at
        FROM ${currentSql(tableFor(String(collection)))}
        WHERE id = ${id} AND owner_id = ${owner}
        LIMIT 1
      `;
      return rows[0] ? rows[0].doc : null;
    },
    async getForUpdate<C extends Collection>(collection: C, id: string): Promise<Doc<C> | null> {
      const txSql = txContext.getStore();
      if (txSql === undefined) {
        throw new Error('getForUpdate requires a transaction: refusing unlocked row access');
      }
      const rows = await txSql<Array<DocRow<Doc<C>>>>`
        SELECT id, owner_id, doc, created_at, updated_at
        FROM ${txSql(tableFor(String(collection)))}
        WHERE id = ${id} AND owner_id = ${owner}
        LIMIT 1
        FOR UPDATE
      `;
      return rows[0] ? rows[0].doc : null;
    },
    async list<C extends Collection>(collection: C, query?: ListQuery): Promise<ListPage<Doc<C>>> {
      return listPage(txContext.getStore() ?? sql, collection, query, owner);
    },
    async put<C extends Collection>(
      collection: C,
      doc: Doc<C>,
      index?: IndexedFields
    ): Promise<Doc<C>> {
      const currentSql = txContext.getStore() ?? sql;
      const record = toRecord(doc);
      const id = readString(record, 'id');
      if (id === undefined) {
        throw new TypeError(`${String(collection)} doc.id must be a string`);
      }
      const tableName = tableFor(String(collection));
      const forced = { ...record, ownerId: owner };
      const fields = projections(forced, index);
      const rows = await currentSql<Array<{ id: string }>>`
        INSERT INTO ${currentSql(tableName)} (id, owner_id, agent_id, conversation_id, run_id, status, kind, parent_id, at, doc, updated_at)
        VALUES (${id}, ${owner}, ${fields.agentId}, ${fields.conversationId}, ${fields.runId},
          ${fields.status}, ${fields.kind}, ${fields.parentId}, ${fields.at},
          ${currentSql.json(toJsonValue(forced) ?? null)}, NOW())
        ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id,
          agent_id = EXCLUDED.agent_id, conversation_id = EXCLUDED.conversation_id,
          run_id = EXCLUDED.run_id, status = EXCLUDED.status, kind = EXCLUDED.kind,
          parent_id = EXCLUDED.parent_id, at = EXCLUDED.at,
          doc = EXCLUDED.doc, updated_at = NOW()
        WHERE ${currentSql(tableName)}.owner_id = ${owner}
        RETURNING id
      `;
      if (rows.length === 0) {
        throw new Error(ownerCollisionMessage(String(collection), id));
      }
      const stored: unknown = { ...record, ownerId: owner };
      if (!isDoc<C>(stored)) {
        throw new TypeError(`${String(collection)} doc.id must be a string`);
      }
      return stored;
    },
    async patch<C extends Collection>(
      collection: C,
      id: string,
      patch: Partial<Doc<C>>
    ): Promise<Doc<C>> {
      // A patch is read-merge-write: run it in a transaction holding the row lock, so two concurrent
      // patches serialize instead of the later one silently dropping the earlier one's fields.
      if (txContext.getStore() === undefined) return base.tx(() => scoped.patch(collection, id, patch));
      const currentSql = txContext.getStore() ?? sql;
      const tableName = tableFor(String(collection));
      const existing = await currentSql<Array<DocRow<Doc<C>>>>`
        SELECT *
        FROM ${currentSql(tableName)}
        WHERE id = ${id} AND owner_id = ${owner}
        LIMIT 1
        FOR UPDATE
      `;
      const current = existing[0];
      if (!current) {
        throw new NotFoundError(String(collection), id);
      }
      const changes = { ...toRecord(patch) };
      delete changes.id;
      delete changes.ownerId;
      delete changes.owner_id;
      const merged = { ...toRecord(current.doc), ...changes };
      const keep = (key: keyof IndexedFields, value: string | null) =>
        Object.hasOwn(changes, key) ? readString(changes, key) ?? null : value;
      const fields = projections(merged, {
        agentId: keep('agentId', current.agent_id),
        conversationId: keep('conversationId', current.conversation_id),
        runId: keep('runId', current.run_id), status: keep('status', current.status),
        kind: keep('kind', current.kind), parentId: keep('parentId', current.parent_id),
      });
      const updated = await currentSql<Array<DocRow<Doc<C>>>>`
        UPDATE ${currentSql(tableName)}
        SET doc = ${currentSql.json(toJsonValue(merged) ?? null)}, updated_at = NOW(),
          owner_id = ${current.owner_id},
          agent_id = ${fields.agentId}, conversation_id = ${fields.conversationId},
          run_id = ${fields.runId}, status = ${fields.status}, kind = ${fields.kind},
          parent_id = ${fields.parentId}, at = ${fields.at}
        WHERE id = ${id} AND owner_id = ${owner}
        RETURNING id, owner_id, doc, created_at, updated_at
      `;
      const row = updated[0];
      if (!row) {
        throw new NotFoundError(String(collection), id);
      }
      return row.doc;
    },
    async delete(collection: Collection, id: string): Promise<void> {
      const currentSql = txContext.getStore() ?? sql;
      await currentSql`
        DELETE FROM ${currentSql(tableFor(String(collection)))}
        WHERE id = ${id} AND owner_id = ${owner}
      `;
    },
    async emit(event: AgentEvent): Promise<void> {
      const currentSql = txContext.getStore() ?? sql;
      const result = await currentSql<Array<{ id: number | bigint | string }>>`
        INSERT INTO events (owner_id, type, payload)
        VALUES (${owner}, ${event.type}, ${currentSql.json(toJsonValue(event) ?? null)})
        RETURNING id
      `;
      const eventId = Number(result[0]?.id ?? 0);
      if (eventId > 0) {
        await notifyEvent(currentSql, eventId);
      }
    },
  };
  return scoped;
}

export function createDocStore({ sql, txContext }: DocStoreOptions): Store {
  const store: Store = {
    forOwner(ownerId: string): Store {
      return scopedStore({ sql, txContext, base: store, owner: ownerId });
    },
    async tx<T>(fn: (store: Store) => Promise<T>): Promise<T> {
      // Join an enclosing transaction instead of opening a second connection, which would wait forever
      // on a row lock the outer transaction holds (patch and appendRunStep open transactions themselves).
      const outer = txContext.getStore();
      if (outer !== undefined) {
        // A savepoint keeps a caught inner failure from aborting the whole outer transaction.
        const nested = await outer.savepoint(async (sp) => ({ value: await txContext.run(sp, () => fn(store)) }));
        return nested.value;
      }
      // `begin` unwraps arrays specially, so return an object to keep the result type exact.
      const outcome = await sql.begin(async (txSql) => ({
        value: await txContext.run(txSql, () => fn(store)),
      }));
      return outcome.value;
    },

    async get<C extends Collection>(collection: C, id: string): Promise<Doc<C> | null> {
      const currentSql = txContext.getStore() ?? sql;
      const rows = await currentSql<Array<DocRow<Doc<C>>>>`
        SELECT id, owner_id, doc, created_at, updated_at
        FROM ${currentSql(tableFor(String(collection)))}
        WHERE id = ${id}
        LIMIT 1
      `;
      return rows[0] ? rows[0].doc : null;
    },

    async getForUpdate<C extends Collection>(collection: C, id: string): Promise<Doc<C> | null> {
      const txSql = txContext.getStore();
      if (txSql === undefined) {
        throw new Error('getForUpdate requires a transaction: refusing unlocked row access');
      }
      const rows = await txSql<Array<DocRow<Doc<C>>>>`
        SELECT id, owner_id, doc, created_at, updated_at
        FROM ${txSql(tableFor(String(collection)))}
        WHERE id = ${id}
        LIMIT 1
        FOR UPDATE
      `;
      return rows[0] ? rows[0].doc : null;
    },

    async list<C extends Collection>(collection: C, query?: ListQuery): Promise<ListPage<Doc<C>>> {
      return listPage(txContext.getStore() ?? sql, collection, query);
    },

    async put<C extends Collection>(
      collection: C,
      doc: Doc<C>,
      index?: IndexedFields
    ): Promise<Doc<C>> {
      const currentSql = txContext.getStore() ?? sql;
      const record = toRecord(doc);
      const id = readString(record, 'id');
      if (id === undefined) {
        throw new TypeError(`${String(collection)} doc.id must be a string`);
      }
      const ownerId = readString(record, 'ownerId') ?? 'unknown';
      const fields = projections(record, index);

      await currentSql`
        INSERT INTO ${currentSql(tableFor(String(collection)))} (id, owner_id, agent_id, conversation_id, run_id, status, kind, parent_id, at, doc, updated_at)
        VALUES (${id}, ${ownerId}, ${fields.agentId}, ${fields.conversationId}, ${fields.runId},
          ${fields.status}, ${fields.kind}, ${fields.parentId}, ${fields.at},
          ${currentSql.json(toJsonValue(record) ?? null)}, NOW())
        ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id,
          agent_id = EXCLUDED.agent_id, conversation_id = EXCLUDED.conversation_id,
          run_id = EXCLUDED.run_id, status = EXCLUDED.status, kind = EXCLUDED.kind,
          parent_id = EXCLUDED.parent_id, at = EXCLUDED.at,
          doc = EXCLUDED.doc, updated_at = NOW()
      `;

      return doc;
    },

    async patch<C extends Collection>(
      collection: C,
      id: string,
      patch: Partial<Doc<C>>
    ): Promise<Doc<C>> {
      // Same as the scoped patch: serialize concurrent read-merge-writes on the row lock.
      if (txContext.getStore() === undefined) return store.tx(() => store.patch(collection, id, patch));
      const currentSql = txContext.getStore() ?? sql;
      const tableName = tableFor(String(collection));
      const existing = await currentSql<Array<DocRow<Doc<C>>>>`
        SELECT *
        FROM ${currentSql(tableName)}
        WHERE id = ${id}
        LIMIT 1
        FOR UPDATE
      `;

      const current = existing[0];
      if (!current) {
        throw new NotFoundError(String(collection), id);
      }

      const changes = toRecord(patch);
      const merged = { ...toRecord(current.doc), ...changes };
      const keep = (key: keyof IndexedFields, value: string | null) =>
        Object.hasOwn(changes, key) ? readString(changes, key) ?? null : value;
      const fields = projections(merged, {
        agentId: keep('agentId', current.agent_id),
        conversationId: keep('conversationId', current.conversation_id),
        runId: keep('runId', current.run_id), status: keep('status', current.status),
        kind: keep('kind', current.kind), parentId: keep('parentId', current.parent_id),
      });

      const updated = await currentSql<Array<DocRow<Doc<C>>>>`
        UPDATE ${currentSql(tableName)}
        SET doc = ${currentSql.json(toJsonValue(merged) ?? null)}, updated_at = NOW(),
          owner_id = ${readString(merged, 'ownerId') ?? current.owner_id},
          agent_id = ${fields.agentId}, conversation_id = ${fields.conversationId},
          run_id = ${fields.runId}, status = ${fields.status}, kind = ${fields.kind},
          parent_id = ${fields.parentId}, at = ${fields.at}
        WHERE id = ${id}
        RETURNING id, owner_id, doc, created_at, updated_at
      `;

      const row = updated[0];
      if (!row) {
        throw new NotFoundError(String(collection), id);
      }
      return row.doc;
    },

    async delete(collection: Collection, id: string): Promise<void> {
      const currentSql = txContext.getStore() ?? sql;
      await currentSql`
        DELETE FROM ${currentSql(tableFor(String(collection)))}
        WHERE id = ${id}
      `;
    },

    async emit(event: AgentEvent): Promise<void> {
      const currentSql = txContext.getStore() ?? sql;
      const lookup: OwnerLookup = async (collection, id) => {
        const owners = await currentSql<Array<{ owner_id: string }>>`
          SELECT owner_id
          FROM ${currentSql(tableFor(String(collection)))}
          WHERE id = ${id}
          LIMIT 1
        `;
        const found = owners[0]?.owner_id;
        return typeof found === 'string' ? found : undefined;
      };
      const ownerId = await resolveEventOwner(event, lookup);

      const result = await currentSql<Array<{ id: number | bigint | string }>>`
        INSERT INTO events (owner_id, type, payload)
        VALUES (${ownerId}, ${event.type}, ${currentSql.json(toJsonValue(event) ?? null)})
        RETURNING id
      `;

      const eventId = Number(result[0]?.id ?? 0);
      if (eventId > 0) {
        await notifyEvent(currentSql, eventId);
      }
    },
  };

  return store;
}

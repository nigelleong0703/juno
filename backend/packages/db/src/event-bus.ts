/**
 * The Postgres EventBus: durable log reads plus LISTEN/NOTIFY delivery for events.
 * The events log grows in `documents.ts` (inside the same transaction as the doc writes); this
 * module only reads it and fans out to live subscribers.
 */
import type { EventBus, StoredEvent } from '@agent-desktop/contracts';
import type { Sql } from './connection.js';
import { createLogger } from '@agent-desktop/log';
import { isAgentEvent } from './guards.js';
import type { EventRow } from './queries.js';

const log = createLogger({ service: 'db' });

const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 100;

/**
 * Reads the event a NOTIFY announced. Delivery is per announced id, not "everything after the last id":
 * ids are assigned at INSERT but become visible at commit, so a later id can commit (and notify) before an
 * earlier one, and a high-water cursor would skip the late event forever. A transient read error is retried
 * and then logged, never swallowed silently.
 */
async function readNotified(sql: Sql, id: number): Promise<EventRow | undefined> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const rows = await sql<EventRow[]>`
        SELECT id, owner_id, payload, created_at
        FROM events
        WHERE id = ${id}
        LIMIT 1
      `;
      return rows[0];
    } catch (err) {
      if (attempt >= READ_ATTEMPTS) {
        log.error({ err, eventId: id }, 'event read failed after retries; live event dropped');
        return undefined;
      }
      await new Promise((r) => setTimeout(r, READ_RETRY_MS * attempt));
    }
  }
}

export interface EventBusOptions {
  /** Query connection for the durable log reads. */
  sql: Sql;
  /** Dedicated connection for LISTEN, opened lazily; kept off the query pool. */
  getListenerPool: () => Sql;
}

/**
 * LISTEN and deliver each announced event to `onEvent` in notification order (one read at a time, so a slow
 * read never reorders). Resolves once LISTEN is active, so no event committed after this returns is missed.
 */
async function listenNotified(
  sql: Sql,
  pool: Sql,
  owner: string | undefined,
  onEvent: (e: StoredEvent) => void,
): Promise<() => void> {
  let chain = Promise.resolve();
  let listening = true;
  const meta = await pool.listen('events', (idText) => {
    if (!listening) return;
    const id = Number(idText);
    chain = chain.then(async () => {
      const row = await readNotified(sql, id);
      if (row && (owner === undefined || row.owner_id === owner) && isAgentEvent(row.payload)) {
        onEvent({ id: Number(row.id), event: row.payload, at: row.created_at });
      }
    }).catch((err: unknown) => {
      // A throwing subscriber must not poison the chain for later events.
      log.error({ err, eventId: id }, 'live event delivery failed');
    });
  });
  return () => {
    listening = false;
    void meta.unlisten().catch((err: unknown) => log.error({ err }, 'events unlisten failed'));
  };
}

export function createEventBus({ sql, getListenerPool }: EventBusOptions): EventBus {
  /** Global max id (the sequence is shared by all owners). Only committed rows are visible to this read. */
  const readHead = async (): Promise<number> => {
    const rows = await sql<{ head: string | number | null }[]>`
      SELECT max(id) AS head FROM events
    `;
    return Number(rows[0]?.head ?? 0);
  };
  /** Retention is global: a scoped bus prunes the same rows as the unscoped one. */
  const prune = async (before: Date): Promise<number> => {
    const result = await sql`DELETE FROM events WHERE created_at < ${before}`;
    return result.count;
  };
  const scopedBus = (owner: string): EventBus => ({
    head: readHead,
    prune,
    async since(afterId: number, limit = 500): Promise<StoredEvent[]> {
      const rows = await sql<EventRow[]>`
        SELECT id, owner_id, payload, created_at
        FROM events
        WHERE id > ${afterId} AND owner_id = ${owner}
        ORDER BY id
        LIMIT ${limit}
      `;
      const out: StoredEvent[] = [];
      for (const row of rows) {
        if (!isAgentEvent(row.payload)) continue;
        out.push({ id: Number(row.id), event: row.payload, at: row.created_at });
      }
      return out;
    },
    subscribe(onEvent: (e: StoredEvent) => void): Promise<() => void> {
      return listenNotified(sql, getListenerPool(), owner, onEvent);
    },
  });
  return {
    forOwner: (owner: string) => scopedBus(owner),
    head: readHead,
    prune,
    async since(afterId: number, limit = 500): Promise<StoredEvent[]> {
      const rows = await sql<EventRow[]>`
        SELECT id, payload, created_at
        FROM events
        WHERE id > ${afterId}
        ORDER BY id
        LIMIT ${limit}
      `;

      const out: StoredEvent[] = [];
      for (const row of rows) {
        if (!isAgentEvent(row.payload)) continue;
        out.push({ id: Number(row.id), event: row.payload, at: row.created_at });
      }
      return out;
    },

    subscribe(onEvent: (e: StoredEvent) => void): Promise<() => void> {
      return listenNotified(sql, getListenerPool(), undefined, onEvent);
    },
  };
}

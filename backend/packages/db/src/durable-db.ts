/** The raw SQL access the durable runner (packages/durable) gets from each store. */
import type { DurableDb, SqlValue } from '@agent-desktop/durable';
import type { Sql, TxSql } from './connection.js';

/** `?` placeholders become `$1, $2, ...`. The runner's SQL has no `?` inside string literals. */
function numbered(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => '$' + String(++n));
}

export function postgresDurableDb(sql: Sql | TxSql): DurableDb {
  const self: DurableDb = {
    async query<T extends object>(text: string, params: readonly SqlValue[] = []): Promise<T[]> {
      const rows = await sql.unsafe(numbered(text), [...params]);
      return Array.from(rows, (row) => ({ ...row }) as T);
    },
    transaction<T>(fn: (tx: DurableDb) => Promise<T>): Promise<T> {
      if (!('begin' in sql)) return fn(self);
      return sql.begin(async (tx) => fn(postgresDurableDb(tx))) as Promise<T>;
    },
  };
  // Only the pool can listen: the driver gives LISTEN a connection of its own and re-listens after a reconnect.
  if ('listen' in sql) {
    self.listen = async (channel, onNotify, onReady) => {
      const listening = await sql.listen(channel, onNotify, onReady);
      return () => listening.unlisten();
    };
  }
  return self;
}

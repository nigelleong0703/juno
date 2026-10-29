/**
 * The Postgres driver seam: the connection type and the factory the store modules share.
 * Kept in one place so query, document and event modules open the driver in the same shape.
 */
import postgres from 'postgres';

/** A pooled Postgres connection as returned by the driver. */
export type Sql = ReturnType<typeof postgres>;
/** The connection bound to a transaction; exposes the same query helpers as Sql. */
export type TxSql = Parameters<Parameters<Sql['begin']>[1]>[0];
/** A connection or a transaction, whichever a query is running on. */
export type Queryable = Sql | TxSql;

/**
 * `max` bounds the pool (the driver's default is 10); LISTEN connections are opened outside it. `idleInTransactionMs` makes Postgres end
 * a session that sits inside an open transaction that long: a process frozen mid-transaction (SIGSTOP, a paused VM) otherwise keeps
 * the row locks of the lease check, and `claim` (FOR UPDATE SKIP LOCKED) skips that invocation, so nobody can take it over.
 */
export function openPostgres(databaseUrl: string, options: { max?: number; idleInTransactionMs?: number } = {}): Sql {
  return postgres(databaseUrl, {
    ...(options.max === undefined ? {} : { max: options.max }),
    ...(options.idleInTransactionMs === undefined ? {} : { connection: { idle_in_transaction_session_timeout: options.idleInTransactionMs } }),
  });
}

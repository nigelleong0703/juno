export type SqlValue = string | number | null;

/**
 * The raw SQL the runner needs from a store. Statements use `?` placeholders and plain SQL that Postgres runs;
 * rows come back as plain objects with lower-case column names.
 */
export interface DurableDb {
  query<T extends object = Record<string, unknown>>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  /** Run `fn` in one transaction; a nested call joins the open one. */
  transaction<T>(fn: (tx: DurableDb) => Promise<T>): Promise<T>;
  /**
   * LISTEN on `channel` over a connection of its own (one per process, not one per call). `onNotify` runs for every NOTIFY, and
   * `onReady` each time the listening starts again after the connection was lost, because notifications sent meanwhile are not
   * replayed. Resolves once LISTEN is active; the returned function stops it. Absent on a handle that cannot listen (a
   * transaction), and on stores without Postgres: the runner then keeps its steady sweep.
   */
  listen?(channel: string, onNotify: (payload: string) => void, onReady?: () => void): Promise<() => Promise<void>>;
}

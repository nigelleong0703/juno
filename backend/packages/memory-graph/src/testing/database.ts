/**
 * A throwaway embedded Postgres with every migration of packages/db applied, and the DurableDb adapter over it (the same mapping
 * packages/db uses; memory-graph does not depend on db, so it carries its own copy). Touches no running database.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import type { DurableDb, SqlValue } from '@agent-desktop/durable';

const MIGRATIONS = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

type Sql = ReturnType<typeof postgres>;
type TxSql = Parameters<Parameters<Sql['begin']>[1]>[0];

export interface TestDatabase {
  db: DurableDb;
  close(): Promise<void>;
}

/** `?` placeholders become `$1, $2, ...`; the SQL in this package has no `?` inside literals. */
function numbered(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => '$' + String(++n));
}

function adapter(sql: Sql | TxSql): DurableDb {
  const self: DurableDb = {
    async query<T extends object>(text: string, params: readonly SqlValue[] = []): Promise<T[]> {
      const rows = await sql.unsafe(numbered(text), [...params]);
      return Array.from(rows, (row) => ({ ...row }) as T);
    },
    transaction<T>(fn: (tx: DurableDb) => Promise<T>): Promise<T> {
      if (!('begin' in sql)) return fn(self);
      return sql.begin(async (tx) => fn(adapter(tx))) as Promise<T>;
    },
  };
  return self;
}

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => done(port));
    });
  });
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const dir = mkdtempSync(join(tmpdir(), 'memory-graph-pg-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: join(dir, 'pg'), port, user: 'postgres', password: 'postgres', persistent: false,
    onLog: () => undefined, onError: () => undefined,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('scratch');
  const sql = postgres(`postgres://postgres:postgres@127.0.0.1:${String(port)}/scratch`, { onnotice: () => undefined });
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    await sql.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  return {
    db: adapter(sql),
    close: async () => {
      await sql.end();
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

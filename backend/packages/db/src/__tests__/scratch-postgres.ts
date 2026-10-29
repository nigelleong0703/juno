/**
 * Throwaway Postgres for the suites: an embedded cluster on a free port, and databases on it with every migration applied.
 * Ids in the shared suites are unique per run (`uid`), so one database serves all the stores a test file opens.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';

const MIGRATIONS = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../migrations');

export interface ScratchPostgres {
  /** A database with every migration applied. */
  url: string;
  /** A new, empty-but-migrated database on the same cluster (for suites that need isolation per test). */
  newDatabase(): Promise<string>;
  close(): Promise<void>;
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

async function migrate(url: string): Promise<void> {
  const sql = postgres(url, { onnotice: () => undefined });
  try {
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      await sql.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8'));
    }
  } finally {
    await sql.end();
  }
}

export async function startScratchPostgres(): Promise<ScratchPostgres> {
  const dir = mkdtempSync(join(tmpdir(), 'juno-scratch-pg-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: join(dir, 'pg'), port, user: 'postgres', password: 'postgres', persistent: false, onLog: () => undefined, onError: () => undefined });
  await pg.initialise();
  await pg.start();
  const urlOf = (database: string): string => `postgres://postgres:postgres@127.0.0.1:${String(port)}/${database}`;
  const newDatabase = async (): Promise<string> => {
    const name = 'd' + randomUUID().replace(/-/g, '').slice(0, 16);
    await pg.createDatabase(name);
    await migrate(urlOf(name));
    return urlOf(name);
  };
  const url = await newDatabase();
  return {
    url,
    newDatabase,
    close: async () => {
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

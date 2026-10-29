/**
 * Account erase covers every owner-scoped table (design §1.4): each table with an owner_id column is a Store collection, an owner
 * table, the event log or an auth table. Erasing one owner removes its identity graph rows and nobody else's.
 * Boots its own throwaway embedded Postgres with every migration applied; touches no running database.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DurableDb } from '@agent-desktop/durable';
import { seedPeople } from '@agent-desktop/memory-graph/testing';
import { postgresDurableDb } from '../durable-db.js';
import { COLLECTION_NAMES, OWNER_TABLES, deleteOwnerRows } from '../owner-erase.js';
import { tableFor } from '../queries.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));

let dir: string;
let pg: EmbeddedPostgres;
let sql: ReturnType<typeof postgres>;
let db: DurableDb;

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => done(port));
    });
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owner-tables-pg-'));
  const port = await freePort();
  pg = new EmbeddedPostgres({ databaseDir: join(dir, 'pg'), port, user: 'postgres', password: 'postgres', persistent: false, onLog: () => undefined, onError: () => undefined });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('scratch');
  sql = postgres(`postgres://postgres:postgres@127.0.0.1:${String(port)}/scratch`, { onnotice: () => undefined });
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    await sql.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  db = postgresDurableDb(sql);
}, 240_000);

afterAll(async () => {
  await sql?.end();
  await pg?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const uid = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`;

/** Row counts of one owner in every owner table of the identity graph. */
async function identityCounts(owner: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of OWNER_TABLES) {
    const [row] = await db.query<{ n: string | number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id = ?`, [owner]);
    counts[table] = Number(row?.n ?? 0);
  }
  return counts;
}

describe('account erase coverage', () => {
  it('lists every table that has an owner_id column', async () => {
    const rows = await db.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'owner_id'`,
    );
    const covered = new Set<string>([...COLLECTION_NAMES.map((collection) => tableFor(collection)), ...OWNER_TABLES, 'events']);
    const uncovered = rows.map((row) => row.table_name).filter((table) => !covered.has(table) && !table.startsWith('auth_'));
    expect(rows.length).toBeGreaterThan(OWNER_TABLES.length);
    expect(uncovered).toEqual([]);
  });

  it('erases one owner\'s identity graph and nobody else\'s, and a second erase removes nothing', async () => {
    const [alice, bob] = [uid('alice'), uid('bob')];
    for (const owner of [alice, bob]) {
      await seedPeople(db, owner, {
        contacts: [
          { name: 'Priya', accounts: [{ platform: 'telegram', externalId: `p-${owner}` }] },
          { name: 'Sam', accounts: [{ platform: 'slack', workspace: 'T1', externalId: `s-${owner}` }] },
        ],
      });
    }

    const aliceBefore = await identityCounts(alice);
    const bobBefore = await identityCounts(bob);
    expect(aliceBefore['people']).toBe(3);
    expect(aliceBefore['accounts']).toBe(2);
    expect(bobBefore['people']).toBe(3);

    const removed = await deleteOwnerRows(db, alice);
    expect(removed).toMatchObject({ people: aliceBefore['people'], accounts: aliceBefore['accounts'] });
    expect(await identityCounts(alice)).toEqual(Object.fromEntries(OWNER_TABLES.map((table) => [table, 0])));
    expect(await identityCounts(bob)).toEqual(bobBefore);
    expect(await deleteOwnerRows(db, alice)).toEqual({});
  });
});

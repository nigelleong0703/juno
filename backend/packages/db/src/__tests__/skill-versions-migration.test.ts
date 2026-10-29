/**
 * Postgres 0049 on a scratch database: every legacy `skills` row becomes a skill definition plus its version 1, active, with the same id
 * (so an agent's skillIds still point at it). The copy keeps the legacy rows, skips team rows, reads a non-numeric usage count as zero, and
 * deleting a version clears the pointer instead of blocking the delete. Boots its own throwaway embedded Postgres; touches no running database.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PG_MIGRATIONS = resolve(HERE, '../../migrations');
const PG_FILE = '0049_skill_versions.sql';

describe('Postgres 0049', () => {
  let dir: string;
  let pg: EmbeddedPostgres;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'skill-versions-migration-pg-'));
    const port = await new Promise<number>((done) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const free = (server.address() as { port: number }).port;
        server.close(() => done(free));
      });
    });
    pg = new EmbeddedPostgres({ databaseDir: join(dir, 'pg'), port, user: 'postgres', password: 'postgres', persistent: false, onLog: () => undefined, onError: () => undefined });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('scratch');
    sql = postgres(`postgres://postgres:postgres@127.0.0.1:${String(port)}/scratch`, { onnotice: () => undefined });
    for (const file of readdirSync(PG_MIGRATIONS).filter((f) => f.endsWith('.sql') && f < PG_FILE).sort()) await sql.unsafe(readFileSync(join(PG_MIGRATIONS, file), 'utf8'));
    await sql`INSERT INTO skills (id, owner_id, doc) VALUES
      ('skl-a', 'owner-a', ${sql.json({ id: 'skl-a', name: 'Pdf reading', description: 'Read PDFs.', instructions: 'Use pdftotext.', owner: 'personal', usedCount: 3 })}),
      ('skl-b', 'owner-a', ${sql.json({ id: 'skl-b', instructions: 'Plain text.', owner: 'personal', usedCount: 'many' })}),
      ('skl-team', 'owner-a', ${sql.json({ id: 'skl-team', name: 'Shared', instructions: 'Team only.', owner: 'team', usedCount: 0 })})`;
    await sql.unsafe(readFileSync(join(PG_MIGRATIONS, PG_FILE), 'utf8'));
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await pg?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('copies each personal legacy skill as a definition with its version 1 active, under the same id', async () => {
    const [def] = await sql<Array<{ id: string; owner_id: string; scope: string; slug: string; active_version_id: string }>>`SELECT * FROM skill_defs WHERE id = 'skl-a'`;
    expect(def).toMatchObject({ owner_id: 'owner-a', scope: 'owner', slug: 'skl-a', active_version_id: 'skv-skl-a' });
    const [version] = await sql<Array<{ status: string; version: number; name: string; description: string; instructions: string; origin: string; used: number; deps: unknown }>>`
      SELECT status, version, name, description, instructions, origin, used, deps FROM skill_versions WHERE id = 'skv-skl-a'`;
    expect(version).toMatchObject({ status: 'active', version: 1, name: 'Pdf reading', description: 'Read PDFs.', instructions: 'Use pdftotext.', origin: 'manual', used: 3 });
    expect(version?.deps).toEqual([]);
  });

  it('reads a non-numeric usage count as zero and a missing name as the id', async () => {
    const [version] = await sql<Array<{ used: number; name: string }>>`SELECT used, name FROM skill_versions WHERE id = 'skv-skl-b'`;
    expect(version).toMatchObject({ used: 0, name: 'skl-b' });
  });

  it('skips team rows, and keeps the legacy rows (a copy, so a code rollback still reads them)', async () => {
    const [team] = await sql`SELECT id FROM skill_defs WHERE id = 'skl-team'`;
    expect(team).toBeUndefined();
    const legacy = await sql<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM skills WHERE owner_id = 'owner-a'`;
    expect(legacy[0]?.n).toBe(3);
  });

  it('deleting a version clears the pointer rather than blocking the delete, so an owner can be erased children first', async () => {
    await sql`INSERT INTO skill_defs (id, owner_id, scope, slug, active_version_id) VALUES ('skl-c', 'owner-c', 'owner', 'skl-c', NULL)`;
    await sql`INSERT INTO skill_versions (id, owner_id, skill_id, version, status, name, instructions, origin)
      VALUES ('skv-skl-c', 'owner-c', 'skl-c', 1, 'active', 'C', 'Text.', 'manual')`;
    await sql`UPDATE skill_defs SET active_version_id = 'skv-skl-c' WHERE id = 'skl-c'`;
    await sql`DELETE FROM skill_versions WHERE owner_id = 'owner-c'`;
    const [def] = await sql<Array<{ active_version_id: string | null }>>`SELECT active_version_id FROM skill_defs WHERE id = 'skl-c'`;
    expect(def?.active_version_id).toBeNull();
    await sql`DELETE FROM skill_defs WHERE owner_id = 'owner-c'`;
    const [left] = await sql`SELECT id FROM skill_defs WHERE owner_id = 'owner-c'`;
    expect(left).toBeUndefined();
  });

  it('refuses a version with an unknown status, and a pointer to a version that is not the owner\'s', async () => {
    await expect(sql`INSERT INTO skill_versions (id, owner_id, skill_id, version, status, name, instructions, origin)
      VALUES ('skv-bad', 'owner-a', 'skl-a', 9, 'bogus', 'X', 'Y', 'manual')`).rejects.toThrow();
    await expect(sql`UPDATE skill_defs SET active_version_id = 'skv-skl-c' WHERE id = 'skl-a'`).rejects.toThrow();
  });
});

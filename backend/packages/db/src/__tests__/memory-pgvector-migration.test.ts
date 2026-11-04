/**
 * Postgres 0072 on a scratch database that already holds jsonb memory vectors (written by the old code): they become vector(n) with n from
 * the data, a vector that does not fit is dropped to be embedded again, and the HNSW index exists. Boots its own throwaway embedded
 * Postgres (with the pgvector stand-in of scripts/dev/pgvector-test-shim.mjs); touches no running database.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PG_MIGRATIONS = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../migrations');
const PG_FILE = '0072_memory_pgvector.sql';

describe('Postgres 0072', () => {
  let dir: string;
  let pg: EmbeddedPostgres;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pgvector-migration-pg-'));
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
    const item = (id: string, embedding: number[] | null, model: string | null) => sql`
      INSERT INTO memory_items (id, owner_id, text, kind, file, said_in, audience, embedding, embed_model)
      VALUES (${id}, 'owner-a', ${'text ' + id}, 'fact', 'memory', 'app', 'owner', ${embedding === null ? null : sql.json(embedding)}, ${model})`;
    await item('mem_ok1', [1, 0, 0], 'jina');
    await item('mem_ok2', [0.5, 0.5, 0], 'jina');
    await item('mem_short', [1, 0], 'jina');
    await item('mem_none', null, null);
    await sql.unsafe(readFileSync(join(PG_MIGRATIONS, PG_FILE), 'utf8'));
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await pg?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('makes the column vector(n) with n from the stored vectors, keeping the ones that fit and clearing the one that does not', async () => {
    const [column] = await sql<Array<{ type: string }>>`SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute WHERE attrelid = 'memory_items'::regclass AND attname = 'embedding'`;
    expect(column?.type).toBe('vector(3)');
    const rows = await sql<Array<{ id: string; embedding: string | null; embed_model: string | null }>>`SELECT id, embedding::text AS embedding, embed_model FROM memory_items ORDER BY id`;
    const by = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(JSON.parse(by['mem_ok1']?.embedding ?? 'null')).toEqual([1, 0, 0]);
    expect(JSON.parse(by['mem_ok2']?.embedding ?? 'null')).toEqual([0.5, 0.5, 0]);
    expect(by['mem_ok1']?.embed_model).toBe('jina');
    expect(by['mem_short']).toMatchObject({ embedding: null, embed_model: null });
    expect(by['mem_none']?.embedding).toBeNull();
  });

  it('creates the HNSW cosine index, and ranks by cosine through it', async () => {
    const [index] = await sql<Array<{ indexdef: string }>>`SELECT indexdef FROM pg_indexes WHERE indexname = 'memory_items_embedding_hnsw'`;
    expect(index?.indexdef).toContain('USING hnsw (embedding vector_cosine_ops)');
    const nearest = await sql<Array<{ id: string }>>`SELECT id FROM memory_items WHERE embedding IS NOT NULL ORDER BY embedding <=> '[1,0,0]'::text::vector LIMIT 2`;
    expect(nearest.map((row) => row.id)).toEqual(['mem_ok1', 'mem_ok2']);
  });
});

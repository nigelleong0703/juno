/**
 * What only the real pgvector extension does, on a real server (PGVECTOR_TEST_URL: a superuser connection to a Postgres 18 with the
 * extension installed, e.g. `docker run pgvector/pgvector:pg18`; CI starts one as a service). The other memory tests run on the embedded
 * Postgres with a stand-in extension (scripts/dev/pgvector-test-shim.mjs), which answers the same queries but has no ANN index and no
 * dimension check. Skipped when the variable is not set.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DurableDb } from '@agent-desktop/durable';
import { createMemoryItems, type MemoryItems } from '../memory/index.js';
import { startRealPgvectorDatabase, type TestDatabase } from '../testing/index.js';

const URL = process.env['PGVECTOR_TEST_URL'];

describe.skipIf(URL === undefined)('memory vectors on real pgvector', () => {
  let database: TestDatabase;
  let db: DurableDb;
  let items: MemoryItems;

  beforeAll(async () => {
    database = await startRealPgvectorDatabase(URL ?? '');
    db = database.db;
    items = createMemoryItems(db);
  }, 120_000);

  afterAll(async () => {
    await database.close();
  });

  it('runs on the real extension, with the column and the HNSW index the migration made', async () => {
    const [extension] = await db.query<{ extversion: string }>(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
    expect(extension?.extversion).toMatch(/^0\.(8|9)|^[1-9]/);
    const [index] = await db.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'memory_items_embedding_hnsw'`);
    expect(index?.indexdef).toContain('USING hnsw (embedding vector_cosine_ops)');
  });

  it('refuses a vector of another length than the column, and aligning the column re-opens it', async () => {
    const owner = 'owner-' + randomUUID();
    const item = await items.addItem(owner, { text: 'Has a vector.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner' });
    await expect(items.setVector(owner, item?.id ?? '', 'Has a vector.', { embedding: [1, 0], embedModel: 'm' })).rejects.toThrow(/dimensions/);
    expect(await items.alignVectorDimension(2)).toBe(true);
    expect(await items.setVector(owner, item?.id ?? '', 'Has a vector.', { embedding: [1, 0], embedModel: 'm' })).toBe(true);
    expect(await items.alignVectorDimension(1024)).toBe(true);
  });

  it('finds the nearest of many owners\' rows through the HNSW index, with the owner filter applied (iterative scan)', async () => {
    const dimension = 1024;
    await db.query(
      `INSERT INTO memory_items (id, owner_id, text, kind, file, said_in, audience, embedding, embed_model)
       SELECT 'syn_' || g, CASE WHEN g <= 4000 THEN 'owner_big' ELSE 'owner_' || (g % 50) END, 'synthetic ' || g, 'fact', 'memory', 'app', 'owner',
         (SELECT ('[' || string_agg(round((random() - 0.5)::numeric, 4)::text, ',') || ']')::vector FROM generate_series(1, ${String(dimension)}) d WHERE d > -g), 'syn'
       FROM generate_series(1, 5000) g`,
    );
    await db.query('ANALYZE memory_items');
    const queryOf = async (id: string): Promise<number[]> => {
      const [row] = await db.query<{ embedding: string }>(`SELECT embedding::text AS embedding FROM memory_items WHERE id = ?`, [id]);
      return (JSON.parse(row?.embedding ?? '[]') as number[]).map((x) => x + 0.0001);
    };

    // The row itself is the nearest of its own owner's, for an owner with thousands of rows and for one with a hundred: the owner
    // filter is applied to the index's candidates and the scan goes on until `limit` rows pass it.
    const big = await items.nearest('owner_big', { kind: 'owner' }, undefined, { embedding: await queryOf('syn_7'), embedModel: 'syn' }, { limit: 5 });
    expect(big).toHaveLength(5);
    expect(big[0]?.id).toBe('syn_7');
    const small = await items.nearest('owner_7', { kind: 'owner' }, undefined, { embedding: await queryOf('syn_4007'), embedModel: 'syn' }, { limit: 5 });
    expect(small).toHaveLength(5);
    expect(small[0]?.id).toBe('syn_4007');

    // The plan of the statement `nearestRows` runs. At 5k rows the planner's own choice is an exact scan of the owner's rows (a few ms);
    // the HNSW index takes over as the table grows. With sorts made impossible (the only way left to satisfy ORDER BY ... LIMIT is an
    // ordered index scan) the plan must be the HNSW index with the owner filter applied to it.
    const explain = async (owner: string, from: string, settings: string[]): Promise<{ plan: string[]; ms: number }> => {
      const vector = JSON.stringify(await queryOf(from));
      const rows = await db.transaction(async (tx) => {
        await tx.query(`SET LOCAL hnsw.iterative_scan = strict_order`);
        for (const setting of settings) await tx.query(`SET LOCAL ${setting}`);
        return tx.query<Record<string, string>>(
          `EXPLAIN ANALYZE SELECT id, 1 - (embedding <=> ?::text::vector) AS cosine FROM memory_items
           WHERE owner_id = ? AND status = 'active' AND embedding IS NOT NULL AND embed_model = ? ORDER BY embedding <=> ?::text::vector LIMIT 50`,
          [vector, owner, 'syn', vector],
        );
      });
      const plan = rows.map((row) => (Object.values(row)[0] ?? '').replace(/\[[-0-9.,e]{40,}\]/g, '[...]'));
      return { plan, ms: Number(/Execution Time: ([\d.]+) ms/.exec(plan.join('\n'))?.[1]) };
    };
    const planner = await explain('owner_big', 'syn_7', []);
    const indexed = await explain('owner_big', 'syn_7', ['enable_seqscan = off', 'enable_bitmapscan = off', 'enable_sort = off']);
    console.log('plan, planner default (owner with 4000 of 5000 rows):\n' + planner.plan.join('\n') + '\nplan, HNSW forced:\n' + indexed.plan.join('\n'));
    expect(indexed.plan.join('\n')).toContain('Index Scan using memory_items_embedding_hnsw');
    expect(planner.ms).toBeLessThan(500);
    expect(indexed.ms).toBeLessThan(500);
  }, 120_000);
});

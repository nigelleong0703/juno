/**
 * Migration 0069: the stored run fields of the delivery split are renamed once (quietEligible -> nobodyWaiting, quietReason -> record,
 * keeping the "Nothing to report: " line the task list showed), and a run without them is left alone.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { closeScratchPostgres, scratchPostgresUrl, uid } from './store-backends';

afterAll(closeScratchPostgres);

const FILE = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../migrations/0069_delivery_split.sql');

describe('Postgres 0069', () => {
  it('renames the two fields and keeps the old result line, and a repeat changes nothing', async () => {
    const sql = postgres(await scratchPostgresUrl(), { onnotice: () => undefined });
    try {
      const owner = uid('owner');
      const [routine, quiet, plain] = [uid('run'), uid('run'), uid('run')];
      const docs = [
        { id: routine, status: 'completed', quietEligible: true },
        { id: quiet, status: 'completed', quietEligible: true, quietReason: 'No new AI news since yesterday' },
        { id: plain, status: 'completed' },
      ];
      for (const doc of docs) await sql`INSERT INTO runs (id, owner_id, doc) VALUES (${doc.id}, ${owner}, ${sql.json(doc as never)})`;

      await sql.unsafe(readFileSync(FILE, 'utf8'));
      await sql.unsafe(readFileSync(FILE, 'utf8'));

      const rows = await sql<Array<{ id: string; doc: Record<string, unknown> }>>`SELECT id, doc FROM runs WHERE owner_id = ${owner}`;
      const byId = Object.fromEntries(rows.map((row) => [row.id, row.doc]));
      expect(byId[routine]).toEqual({ id: routine, status: 'completed', nobodyWaiting: true });
      expect(byId[quiet]).toEqual({ id: quiet, status: 'completed', nobodyWaiting: true, record: 'Nothing to report: No new AI news since yesterday' });
      expect(byId[plain]).toEqual({ id: plain, status: 'completed' });
    } finally {
      await sql.end();
    }
  });
});

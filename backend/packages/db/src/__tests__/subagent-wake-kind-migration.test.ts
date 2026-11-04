/**
 * Migration 0071: the stored wake kind `child_task` becomes `subagent_task` wherever it is a JSON value, and text that only mentions
 * it inside a string is left alone.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { closeScratchPostgres, scratchPostgresUrl, uid } from './store-backends';

afterAll(closeScratchPostgres);

const FILE = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../migrations/0071_subagent_wake_kind.sql');

describe('Postgres 0071', () => {
  it('renames the wake kind in run origins and leaves prose alone, and a repeat changes nothing', async () => {
    const sql = postgres(await scratchPostgresUrl(), { onnotice: () => undefined });
    try {
      const owner = uid('owner');
      const [orphan, prose] = [uid('run'), uid('run')];
      const docs = [
        { id: orphan, rootOrigin: { type: 'system', wakeKind: 'child_task', label: 'parent run not found' } },
        { id: prose, title: 'woken as a "child_task" once' },
      ];
      for (const doc of docs) await sql`INSERT INTO runs (id, owner_id, doc) VALUES (${doc.id}, ${owner}, ${sql.json(doc as never)})`;

      await sql.unsafe(readFileSync(FILE, 'utf8'));
      await sql.unsafe(readFileSync(FILE, 'utf8'));

      const rows = await sql<Array<{ id: string; doc: Record<string, unknown> }>>`SELECT id, doc FROM runs WHERE owner_id = ${owner}`;
      const byId = Object.fromEntries(rows.map((row) => [row.id, row.doc]));
      expect(byId[orphan]).toEqual({ id: orphan, rootOrigin: { type: 'system', wakeKind: 'subagent_task', label: 'parent run not found' } });
      expect(byId[prose]).toEqual(docs[1]);
    } finally {
      await sql.end();
    }
  });
});

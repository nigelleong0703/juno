/**
 * Migration 0061: steps already stored get `internal` when their tool is plumbing, both in the steps table and in the copy inside
 * the run. A step from before the `tool` field is recognised by its "Executed <tool>" target; anything else is left alone.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { PLUMBING_TOOLS } from 'juno-agent/modules/tools/plumbing';
import { closeScratchPostgres, scratchPostgresUrl, uid } from './store-backends';

afterAll(closeScratchPostgres);

const FILE = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../migrations/0062_step_internal.sql');
const AT = '2026-10-20T08:00:00.000Z';
const step = (id: string, extra: Record<string, unknown>) => ({ id, runId: 'r', index: 0, kind: 'mcp', verb: 'Executed', target: 'x', status: 'completed', startedAt: AT, durationMs: 1, ...extra });

describe('Postgres 0061', () => {
  it('marks plumbing steps in the table and inside their run, and only those', async () => {
    const sql = postgres(await scratchPostgresUrl(), { onnotice: () => undefined });
    try {
      const owner = uid('owner');
      const [search, legacy, work, runId] = [uid('stp'), uid('stp'), uid('stp'), uid('run')];
      const steps = [step(search, { tool: 'tool_search', target: 'tool_search' }), step(legacy, { target: 'todo_write' }), step(work, { tool: 'browser.click', target: 'browser.click' })];
      for (const doc of steps) await sql`INSERT INTO steps (id, owner_id, run_id, doc) VALUES (${doc.id}, ${owner}, ${runId}, ${sql.json(doc as never)})`;
      await sql`INSERT INTO runs (id, owner_id, doc) VALUES (${runId}, ${owner}, ${sql.json({ id: runId, status: 'completed', steps } as never)})`;

      await sql.unsafe(readFileSync(FILE, 'utf8'));
      await sql.unsafe(readFileSync(FILE, 'utf8'));

      const rows = await sql<Array<{ id: string; doc: { internal?: boolean } }>>`SELECT id, doc FROM steps WHERE run_id = ${runId} ORDER BY id`;
      const internal = Object.fromEntries(rows.map((row) => [row.id, row.doc.internal]));
      expect(internal).toEqual({ [search]: true, [legacy]: true, [work]: undefined });
      const [run] = await sql<Array<{ doc: { steps: Array<{ id: string; internal?: boolean }> } }>>`SELECT doc FROM runs WHERE id = ${runId}`;
      expect(run?.doc.steps.map((entry) => [entry.id, entry.internal])).toEqual([[search, true], [legacy, true], [work, undefined]]);
    } finally {
      await sql.end();
    }
  });

  it('uses the same tool list as the code that marks new steps', () => {
    const arrays = [...readFileSync(FILE, 'utf8').matchAll(/ARRAY\[([^\]]*)\]/g)].map((match) => match[1] ?? '');
    expect(arrays).toHaveLength(3);
    const listed = arrays.flatMap((body) => [...body.matchAll(/'([a-z_.]+)'/g)].map((match) => match[1]));
    expect(new Set(listed)).toEqual(PLUMBING_TOOLS);
  });
});

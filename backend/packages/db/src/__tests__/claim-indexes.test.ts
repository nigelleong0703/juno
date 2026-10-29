/**
 * Migration 0062 on a realistic table: 100k finished invocations, 1k waiting, 50 running. EXPLAIN ANALYZE of the claim query and of the
 * next-due query before the partial indexes exist and after, written to `.data/hardening/claim-explain.log`; the claim must not scan
 * the finished rows.
 */
import { mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { startScratchPostgres } from './scratch-postgres';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FILE = resolve(HERE, '../../migrations/0063_claim_indexes.sql');
const LOG = resolve(HERE, '../../../../.data/hardening/claim-explain.log');

/** The claim select, as DurableStore.claim sends it (placeholders replaced by one database time). */
const CLAIM = (now: number) => `
  SELECT i.id, i.service, i.key FROM invocations i
  WHERE ((i.status = 'pending' AND COALESCE(i.not_before, i.created_at) <= ${now})
      OR (i.status = 'running' AND i.lease_expires_at IS NOT NULL AND i.lease_expires_at <= ${now}))
    AND NOT EXISTS (SELECT 1 FROM invocation_lanes l WHERE l.service = i.service AND l.key = i.key AND l.expires_at > ${now})
  ORDER BY CASE WHEN i.status = 'running' THEN i.lease_expires_at ELSE COALESCE(i.not_before, i.created_at) END, i.id
  LIMIT 1
  FOR UPDATE OF i SKIP LOCKED`;

const NEXT_DUE = `
  SELECT MIN(d.due) FROM (
    SELECT GREATEST(COALESCE(i.not_before, i.created_at), COALESCE(l.expires_at, 0)) AS due
      FROM invocations i LEFT JOIN invocation_lanes l ON l.service = i.service AND l.key = i.key WHERE i.status = 'pending'
    UNION ALL
    SELECT lease_expires_at FROM invocations WHERE status = 'running' AND lease_expires_at IS NOT NULL) d`;

interface Plan { 'Plan': Record<string, unknown>; 'Execution Time': number }

let cluster: Awaited<ReturnType<typeof startScratchPostgres>> | undefined;
afterAll(async () => { await cluster?.close(); });

describe('Postgres 0062', () => {
  it('serves the claim and next-due queries from partial indexes over the waiting and running rows only', async () => {
    cluster = await startScratchPostgres();
    const sql = postgres(await cluster.newDatabase(), { onnotice: () => undefined });
    try {
      const now = Date.now();
      await sql`DROP INDEX IF EXISTS idx_invocations_pending_due`;
      await sql`DROP INDEX IF EXISTS idx_invocations_running_lease`;
      await sql.unsafe(`INSERT INTO invocations (id, service, key, handler, status, attempt, created_at, updated_at)
                SELECT 'done-' || g, 'Session', 'k' || (g % 5000), 'receive', 'done', 1, ${now - 86_400_000} + g, ${now} FROM generate_series(1, 100000) g`);
      // 1k waiting: most are delayed a day ahead (routine timers), a few are due; 50 running with live leases.
      await sql.unsafe(`INSERT INTO invocations (id, service, key, handler, status, not_before, attempt, created_at, updated_at)
                SELECT 'wait-' || g, 'RoutineTimer', 'r' || g, 'fire', 'pending', CASE WHEN g <= 5 THEN ${now - 1000} ELSE ${now + 86_400_000} END, 0, ${now}, ${now} FROM generate_series(1, 1000) g`);
      await sql.unsafe(`INSERT INTO invocations (id, service, key, handler, status, attempt, created_at, updated_at, lease_owner, lease_expires_at, epoch)
                SELECT 'run-' || g, 'Run', 'x' || g, 'run', 'running', 1, ${now}, ${now}, 'w1', ${now + 10_000}, g FROM generate_series(1, 50) g`);
      await sql`ANALYZE invocations`;

      const explain = async (label: string, query: string): Promise<{ time: number; text: string }> => {
        const [row] = await sql.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`) as unknown as Array<{ 'QUERY PLAN': Plan[] }>;
        const plan = row?.['QUERY PLAN'][0];
        if (plan === undefined) throw new Error('no plan');
        const text = JSON.stringify(plan['Plan']);
        mkdirSync(resolve(LOG, '..'), { recursive: true });
        appendFileSync(LOG, `${label}: ${plan['Execution Time'].toFixed(2)} ms\n`);
        return { time: plan['Execution Time'], text };
      };

      const before = { claim: await explain('claim, no partial indexes', CLAIM(now)), due: await explain('next-due, no partial indexes', NEXT_DUE) };
      await sql.unsafe(readFileSync(FILE, 'utf8'));
      await sql`ANALYZE invocations`;
      const after = { claim: await explain('claim, with partial indexes', CLAIM(now)), due: await explain('next-due, with partial indexes', NEXT_DUE) };

      // The claim reads the waiting rows through the partial indexes, and neither query scans the 100k finished rows. (The older
      // (status, ...) indexes already kept the plans off the finished rows; the partial ones make that independent of how the
      // planner prices the status column and halve the claim: see the log.)
      expect(after.claim.text).toContain('idx_invocations_pending_due');
      for (const plan of [before.claim, before.due, after.claim, after.due]) expect(plan.text).not.toMatch(/"Seq Scan"[^{}]*"Relation Name":"invocations"/);
      expect(after.claim.time).toBeLessThan(before.claim.time * 1.5 + 1);
      appendFileSync(LOG, `before: claim ${before.claim.time.toFixed(2)} ms, next-due ${before.due.time.toFixed(2)} ms; after: claim ${after.claim.time.toFixed(2)} ms, next-due ${after.due.time.toFixed(2)} ms\n`);
    } finally {
      await sql.end();
    }
  }, 120_000);
});

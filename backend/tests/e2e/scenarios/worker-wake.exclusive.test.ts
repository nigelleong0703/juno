import { describe, expect, it } from 'vitest';
import { execStack, queryStack, stackUrls } from '../harness/client';

/**
 * Idle workers listen instead of polling (BACKEND 2.2c), on the split stack: one coordinator and two workers as separate OS
 * processes against one Postgres. Needs `E2E_WORKERS=2 E2E_ONLY=worker-wake pnpm test:e2e`; skipped on the one-process stack.
 *
 * "Claim queries" are counted from the database: every claim pass reads `invocations` (an index scan or a scan, one or two per
 * pass), so the growth of `idx_scan + seq_scan` on that table is the passes made plus the writes (a lease renewal is an update by
 * primary key, a claim an update, an enqueue an insert). Take the writes off and what is left is reading: the claim passes and the
 * looks at the next due time. Two polling workers made about 4 such scans a second whatever happened; listening ones make them
 * only after an enqueue or when a timer says something is due.
 */
const split = stackUrls().workers >= 2;
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function counters(): Promise<{ scans: number; writes: number }> {
  const row = (await queryStack("SELECT (COALESCE(seq_scan, 0) + COALESCE(idx_scan, 0))::bigint AS scans, (COALESCE(n_tup_ins, 0) + COALESCE(n_tup_upd, 0))::bigint AS writes FROM pg_stat_user_tables WHERE relname = 'invocations'"))[0];
  return { scans: Number(row?.['scans'] ?? 0), writes: Number(row?.['writes'] ?? 0) };
}

const SECONDS = 30;
/** Seconds that must show no read at all. Measured on this stack (2026-10-29, after the `worker-leases` scenarios left delayed timers behind): 22 of 24 seconds on a fresh stack, 6 of 8 ten-second windows with none; polling shows reads in every second. */
const QUIET_SECONDS = 18;

describe.skipIf(!split)('idle workers on the split stack', () => {
  it('look at the invocations only when woken, not on a clock', async () => {
    // Reads are not bounded by a count: the stack is never fully quiet. A notification (an insert, a finished invocation, a freed
    // lease) wakes BOTH workers, and so does a delayed row (an account's idea or memory timer) coming due, and a worker starting
    // work; each wake costs a claim pass and a look at the next due time (4 to 6 scans), 15 to 16 reads for one timer that fires and
    // finishes. Every worker also sweeps once in 30 s. A polling worker is different in kind: it reads once a second, in every
    // second. So count the seconds with no read at all (scans minus the statement's own writes, read once a second), and require
    // most of them to be quiet. The exact "no claim query between sweeps" check is the durable `notify.test.ts` (it counts statements
    // in the process, with no statistics lag).
    await pause(3_000);
    let last = await counters();
    let quiet = 0;
    const reads: number[] = [];
    for (let second = 0; second < SECONDS; second += 1) {
      await pause(1_000);
      const now = await counters();
      const read = now.scans - last.scans - (now.writes - last.writes);
      reads.push(read);
      if (read <= 0) quiet += 1;
      last = now;
    }
    expect(quiet, `seconds with no read scan of invocations, out of ${String(SECONDS)} (reads per second: ${reads.join(' ')})`).toBeGreaterThanOrEqual(QUIET_SECONDS);
  }, 90_000);

  it('hands work that appears in the database to an idle worker within 200 ms', async () => {
    const latencies: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const id = 'wake-probe-' + String(round) + '-' + String(Date.now());
      // What the coordinator's enqueue does: a pending row and a notification in one transaction. No handler is registered for the
      // service, so the claim itself (updated_at, attempt) is the observable.
      await execStack(`WITH made AS (
        INSERT INTO invocations (id, service, key, handler, status, attempt, created_at, updated_at)
        VALUES (?, 'WakeProbe', ?, 'go', 'pending', 0, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
        RETURNING id) SELECT pg_notify('durable_work', '') FROM made`, [id, id]);
      let claimedAfter: number | undefined;
      for (let i = 0; i < 100 && claimedAfter === undefined; i += 1) {
        const row = (await queryStack('SELECT attempt, updated_at - created_at AS took FROM invocations WHERE id = ?', [id]))[0];
        if (row !== undefined && Number(row['attempt']) >= 1) claimedAfter = Number(row['took']);
        else await pause(10);
      }
      latencies.push(claimedAfter ?? Number.POSITIVE_INFINITY);
      await execStack('DELETE FROM invocations WHERE id = ?', [id]);
      await execStack("DELETE FROM invocation_lanes WHERE service = 'WakeProbe'");
      await pause(300);
    }
    latencies.sort((a, b) => a - b);
    // The claim is stamped in database time; the slowest of five bounds it.
    expect(latencies.at(-1), 'claim latencies (ms): ' + latencies.join(', ')).toBeLessThan(200);
  }, 60_000);
});

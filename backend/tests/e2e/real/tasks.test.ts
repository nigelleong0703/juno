import { afterAll, describe, expect, it } from 'vitest';
import { runTask } from './tasks/driver';
import { record, summaryTable, writeReport, type TaskRecord } from './tasks/report';
import { TASKS } from './tasks/specs/index';
import type { CheckResult } from './tasks/types';

/**
 * Real tasks (`pnpm test:e2e:tasks`): written cases, a real model and a real local computer. Each case is the user's message(s) plus a
 * script for what the user does when asked (answers, approvals, take-over), and checks on what actually happened. Needs
 * E2E_COMPUTER_PROVIDER=local (image juno-desktop:local). `E2E_TASKS=apple-mac-mini,tokyo-itinerary` runs a subset.
 * The report goes to `.data/e2e/real-reports/<timestamp>.json`; see tests/e2e/README.md.
 */
const wanted = (process.env['E2E_TASKS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const selected = TASKS.filter((t) => wanted.length === 0 || wanted.includes(t.id));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const records: TaskRecord[] = [];

describe.skipIf(process.env['E2E_COMPUTER_PROVIDER'] !== 'local' || process.env['E2E_REAL_MODEL'] === undefined)('real tasks', () => {
  afterAll(() => {
    if (records.length === 0) return;
    const file = writeReport(stamp, process.env['E2E_REAL_MODEL'] ?? '', records);
    console.log('\n' + summaryTable(records) + `\n\nreport: ${file}\n`);
  });

  for (const spec of selected) {
    it(spec.id + ': ' + spec.title, async () => {
      let ran: Awaited<ReturnType<typeof runTask>> | undefined;
      let checks: CheckResult[] = [];
      let error: string | undefined;
      const stopFixture = await spec.fixture?.();
      try {
        ran = await runTask(spec);
        for (const check of spec.checks) checks = checks.concat(await check(ran.observed, ran.env));
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        await stopFixture?.();
        const removed = ran?.cleanup() ?? [];
        if (removed.length === 0 && ran !== undefined) console.warn(`[tasks] ${spec.id}: found no computer to clean up`);
      }
      const row = record(spec.id, spec.title, ran?.observed, checks, error);
      records.push(row);
      writeReport(stamp, process.env['E2E_REAL_MODEL'] ?? '', records);
      expect(error, 'task could not run').toBeUndefined();
      expect(checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail ?? ''}`)).toEqual([]);
    }, spec.timeoutMs + 300_000);
  }
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableDb } from '@agent-desktop/durable';
import { buildWeeklyReport, latestReportTime, writeWeeklyReport } from '../weekly.js';

const NOW = new Date('2026-10-26T06:00:00.000Z');

// Text that must never reach a report: a validation teaching line echoing a value, a timeout URL with a token, a user message.
const SECRET_SUMMARY = 'Error: invalid calendar_add arguments.\n- meeting.startAt: received "dinner with alice@example.com at 7pm"; expected a date-time.';
const SECRET_URL = 'Tool web_fetch failed: timed out for https://secret.example/private?token=abc';
const SECRET_TEXT = 'my salary is 90k, do not tell anyone';

const STEP_ROWS = [
  { step_id: 'stp_1', run_id: 'run_1', tool: 'calendar_add', status: 'failed', error_kind: 'validation', retry_of: null, summary: SECRET_SUMMARY, model: 'm1' },
  { step_id: 'stp_2', run_id: 'run_1', tool: 'calendar_add', status: 'completed', error_kind: null, retry_of: 'stp_1', summary: 'Added dinner', model: 'm1' },
  { step_id: 'stp_3', run_id: 'run_2', tool: 'web_fetch', status: 'failed', error_kind: 'timeout', retry_of: null, summary: SECRET_URL, model: 'm2' },
];
const RUN_ROWS = [
  { run_id: 'run_1', model: 'm1', conversation_id: 'conv_1', at: '2026-10-25T10:00:00Z', finished_at: '2026-10-25T10:01:00Z' },
  { run_id: 'run_2', model: 'm2', conversation_id: null, at: '2026-10-25T11:00:00Z', finished_at: null },
];
const MESSAGE_ROWS = [
  { conversation_id: 'conv_1', at: '2026-10-25T09:59:00Z', text: 'add dinner tomorrow at 7' },
  { conversation_id: 'conv_1', at: '2026-10-25T10:02:00Z', text: 'no, that is wrong, I said 7pm' },
  { conversation_id: 'conv_1', at: '2026-10-25T10:30:00Z', text: SECRET_TEXT },
];

function fakeDb(): { db: DurableDb; calls: Array<{ sql: string; params: readonly unknown[] }> } {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM steps')) return STEP_ROWS;
      if (sql.includes('FROM runs')) return RUN_ROWS;
      return MESSAGE_ROWS;
    },
  } as unknown as DurableDb;
  return { db, calls };
}

const log = { info: vi.fn(), error: vi.fn() };
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eval-weekly-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('buildWeeklyReport', () => {
  it('reads the last seven days from the database and groups the failures with their attribution', async () => {
    const { db, calls } = fakeDb();
    const report = await buildWeeklyReport({ db, log, now: () => NOW });
    expect(calls.map((call) => call.params[0])).toEqual(['2026-10-19T06:00:00.000Z', '2026-10-19T06:00:00.000Z', '2026-10-19T06:00:00.000Z']);
    expect(report).toMatchObject({ runs: 2, runsByModel: { m1: 1, m2: 1 }, toolSteps: 3, failedSteps: 2, correctedRunIds: ['run_1'] });
    expect(report.groups[0]).toMatchObject({ tool: 'calendar_add', field: 'meeting', errorKind: 'validation', model: 'm1', count: 1, retried: 1, retryRate: 1 });
    expect(report.buckets.find((bucket) => bucket.bucket === 'agent_method')).toMatchObject({ runs: 1, exampleRunIds: ['run_1'] });
  });
});

describe('writeWeeklyReport', () => {
  it('writes a markdown and a JSON report with ids and names only: no argument, output, URL or message text', async () => {
    const { db } = fakeDb();
    const { markdownPath, jsonPath } = await writeWeeklyReport({ db, log, dir, now: () => NOW });
    expect(markdownPath).toBe(join(dir, 'weekly', 'weekly-2026-10-26.md'));
    expect(jsonPath).toBe(join(dir, 'weekly', 'weekly-2026-10-26.json'));
    const markdown = await readFile(markdownPath, 'utf8');
    const json = await readFile(jsonPath, 'utf8');
    for (const report of [markdown, json]) {
      for (const secret of ['alice@example.com', 'secret.example', 'token=abc', SECRET_TEXT, 'add dinner tomorrow', 'no, that is wrong', 'Added dinner']) {
        expect(report).not.toContain(secret);
      }
    }
    expect(markdown).toContain('| calendar_add | meeting | validation | m1 | 1 | 100% | 1 (100%) | stp_1 |');
    expect(markdown).toContain('stp_3');
  });

  it('a later check sees the report it wrote, so a restart in the same week writes no second report', async () => {
    expect(await latestReportTime(dir)).toBeUndefined();
    const { db } = fakeDb();
    await writeWeeklyReport({ db, log, dir, now: () => NOW });
    expect(await latestReportTime(dir)).toBe(Date.parse('2026-10-26T00:00:00Z'));
  });
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckResult, Observed } from './types';

export interface TaskRecord {
  id: string;
  title: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  /** null = the model has no configured price (see `inputTokens`/`outputTokens`). */
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  /** Tool name -> number of calls. */
  tools: Record<string, number>;
  /** Every call in order, as `name {args}` (args cut to 200 characters): the run's tool sequence. */
  sequence: string[];
  toolErrors: Array<{ tool: string; text: string }>;
  interactions: Observed['interactions'];
  checks: CheckResult[];
  replies: string[];
}

/** `.data/e2e/real-reports/` (the stack keeps this folder when it cleans up). */
export const reportDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'), '.data', 'e2e', 'real-reports');

export function record(id: string, title: string, observed: Observed | undefined, checks: CheckResult[], error?: string): TaskRecord {
  const tools: Record<string, number> = {};
  for (const call of observed?.calls ?? []) tools[call.name] = (tools[call.name] ?? 0) + 1;
  return {
    id, title,
    ok: error === undefined && checks.length > 0 && checks.every((c) => c.ok),
    ...(error === undefined ? {} : { error }),
    durationMs: observed?.durationMs ?? 0,
    costUsd: observed === undefined || !observed.costKnown ? null : observed.costUsd,
    inputTokens: observed?.inputTokens ?? 0,
    outputTokens: observed?.outputTokens ?? 0,
    tools,
    sequence: (observed?.calls ?? []).map((call) => call.name + ' ' + JSON.stringify(call.args).slice(0, 200)),
    toolErrors: (observed?.results ?? []).filter((r) => r.isError).map((r) => ({ tool: r.toolName, text: r.text.slice(0, 300) })),
    interactions: observed?.interactions ?? [],
    checks,
    replies: (observed?.turns ?? []).flatMap((t) => t.replies).map((r) => r.slice(0, 1_500)),
  };
}

export function writeReport(stamp: string, model: string, records: TaskRecord[]): string {
  mkdirSync(reportDir, { recursive: true });
  const file = join(reportDir, `${stamp}.json`);
  const totals = { tasks: records.length, passed: records.filter((r) => r.ok).length, durationMs: records.reduce((n, r) => n + r.durationMs, 0), costUsd: records.some((r) => r.costUsd === null) ? null : records.reduce((n, r) => n + (r.costUsd ?? 0), 0), inputTokens: records.reduce((n, r) => n + r.inputTokens, 0), outputTokens: records.reduce((n, r) => n + r.outputTokens, 0) };
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), model, totals, tasks: records }, null, 2));
  return file;
}

const pad = (text: string, width: number) => (text.length > width ? text.slice(0, width - 1) + '~' : text.padEnd(width));

export function summaryTable(records: TaskRecord[]): string {
  const head = `${pad('task', 22)} ${pad('result', 6)} ${pad('checks', 7)} ${pad('tools', 6)} ${pad('errors', 6)} ${pad('time', 7)} ${pad('cost', 9)} failed checks`;
  const rows = records.map((r) => {
    const calls = Object.values(r.tools).reduce((a, b) => a + b, 0);
    const failed = r.error !== undefined ? `ERROR ${r.error.slice(0, 80)}` : r.checks.filter((c) => !c.ok).map((c) => c.name).join('; ');
    return `${pad(r.id, 22)} ${pad(r.ok ? 'PASS' : 'FAIL', 6)} ${pad(`${r.checks.filter((c) => c.ok).length}/${r.checks.length}`, 7)} ${pad(String(calls), 6)} ${pad(String(r.toolErrors.length), 6)} ${pad(`${Math.round(r.durationMs / 1000)}s`, 7)} ${pad(r.costUsd === null ? `${Math.round((r.inputTokens + r.outputTokens) / 1000)}k tok` : `$${r.costUsd.toFixed(3)}`, 9)} ${failed}`;
  });
  return [head, '-'.repeat(head.length), ...rows].join('\n');
}

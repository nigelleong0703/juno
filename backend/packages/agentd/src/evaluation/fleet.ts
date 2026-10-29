/**
 * Platform metrics (BACKEND §5.15): aggregated across all owners, no message text and no owner id. Two parts:
 * - fleet: the generic rates over the runs of the window (correction, method failure, retry, abandon, cost per run);
 * - skills: per platform skill version, exposures, good and bad counts, and the bad rate with its Wilson interval (platform.metrics()).
 * Read by the weekly report and by the internal admin read; it is a developer's instrument, not something an agent can open.
 */
import type { DurableDb } from '@agent-desktop/durable';
import { METRICS_WINDOW_DAYS, type PlatformSkillsService, type SkillMetrics } from '@agent-desktop/memory-graph/skills';
import type { Outcome } from './outcomes.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const OUTCOMES: readonly Outcome[] = ['ok', 'corrected', 'failed_method', 'failed_other', 'abandoned', 'unknown'];

export interface FleetMetrics {
  windowDays: number;
  /** Runs started in the window. */
  runs: number;
  /** Of those, the runs that have a label. */
  labeled: number;
  byOutcome: Record<Outcome, number>;
  /** Rates are over labelled runs that are not `unknown`. */
  correctionRate: number;
  methodFailureRate: number;
  abandonRate: number;
  /** Runs with at least one retry step, over all runs of the window. */
  retryRate: number;
  /** Mean cost of the runs whose cost is known; null when none is. */
  costPerRunUsd: number | null;
}

export interface SkillEvolutionReport {
  generatedAt: string;
  fleet: FleetMetrics;
  skills: SkillMetrics[];
}

type Row = Record<string, unknown>;
const num = (value: unknown): number => Number(value ?? 0);
const ratio = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);

export async function fleetMetrics(db: DurableDb, now: Date = new Date()): Promise<FleetMetrics> {
  const from = new Date(now.getTime() - METRICS_WINDOW_DAYS * DAY_MS).toISOString();
  const byOutcome = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<Outcome, number>;
  const grouped = await db.query<Row>(
    `SELECT COALESCE(r.doc->>'outcome', '-') AS outcome, COUNT(*) AS n FROM runs r WHERE r.at >= ?::timestamptz GROUP BY 1`,
    [from],
  );
  let runs = 0;
  let labeled = 0;
  for (const row of grouped) {
    const outcome = String(row['outcome']);
    runs += num(row['n']);
    if (outcome in byOutcome) {
      byOutcome[outcome as Outcome] = num(row['n']);
      labeled += num(row['n']);
    }
  }
  const [retried] = await db.query<Row>(
    `SELECT COUNT(DISTINCT s.run_id) AS n FROM steps s JOIN runs r ON r.id = s.run_id WHERE r.at >= ?::timestamptz AND s.doc->>'retryOf' IS NOT NULL`,
    [from],
  );
  const [cost] = await db.query<Row>(
    `SELECT COUNT(*) AS n, COALESCE(SUM((r.doc->'usage'->>'costUsd')::float8), 0) AS total FROM runs r
     WHERE r.at >= ?::timestamptz AND r.doc->'usage'->>'costUsd' IS NOT NULL AND COALESCE(r.doc->'usage'->>'costKnown', 'true') <> 'false'`,
    [from],
  );
  const judged = labeled - byOutcome.unknown;
  const costRuns = num(cost?.['n']);
  return {
    windowDays: METRICS_WINDOW_DAYS,
    runs,
    labeled,
    byOutcome,
    correctionRate: ratio(byOutcome.corrected, judged),
    methodFailureRate: ratio(byOutcome.failed_method, judged),
    abandonRate: ratio(byOutcome.abandoned, judged),
    retryRate: ratio(num(retried?.['n']), runs),
    costPerRunUsd: costRuns === 0 ? null : num(cost?.['total']) / costRuns,
  };
}

export async function skillEvolutionReport(db: DurableDb, platform: PlatformSkillsService, now: Date = new Date()): Promise<SkillEvolutionReport> {
  return { generatedAt: now.toISOString(), fleet: await fleetMetrics(db, now), skills: await platform.metrics() };
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** The report's markdown section: numbers only. */
export function renderSkillEvolution(report: SkillEvolutionReport): string[] {
  const { fleet } = report;
  const lines = [
    '## Platform skills and fleet metrics',
    '',
    `Window: ${fleet.windowDays} days. Runs: ${fleet.runs}, labelled: ${fleet.labeled}. Correction rate ${pct(fleet.correctionRate)}, method-failure rate ${pct(fleet.methodFailureRate)}, retry rate ${pct(fleet.retryRate)}, abandon rate ${pct(fleet.abandonRate)}, cost per run ${fleet.costPerRunUsd === null ? 'unknown' : '$' + fleet.costPerRunUsd.toFixed(4)}.`,
    `Outcomes: ${Object.entries(fleet.byOutcome).map(([name, n]) => `${name} ${n}`).join(', ')}.`,
    '',
    '| skill | source | version | status | origin | exposures | good | bad | bad rate (95% Wilson) | ops | decision |',
    '| --- | --- | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | --- |',
  ];
  for (const skill of report.skills) {
    for (const version of skill.versions) {
      lines.push(`| ${skill.skillId} | ${skill.source} | ${version.version} | ${version.status} | ${version.origin} | ${version.exposures} | ${version.good} | ${version.bad} | ${pct(version.badRate)} (${pct(version.badRateLow)} to ${pct(version.badRateHigh)}) | ${version.opCount} | ${version.decision ?? ''} |`);
    }
  }
  if (report.skills.length === 0) lines.push('| none | | | | | | | | | | |');
  lines.push('');
  return lines;
}

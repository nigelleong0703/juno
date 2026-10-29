/**
 * The weekly server job (BACKEND §11.1): reads the last seven days of tool steps across all owners, groups the failures, attributes them
 * and writes the report to the server's reports folder (`<EVAL_REPORTS_DIR>/weekly/`, private permissions). It is an operator job: it reads
 * every owner's rows but writes aggregates only (tool, field, kind, model names and ids), never a step argument, an output or a message.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DurableDb } from '@agent-desktop/durable';
import type { PlatformSkillsService } from '@agent-desktop/memory-graph/skills';
import { evalReportsDir } from 'juno-agent/modules/evaluation/paths';
import { renderSkillEvolution, skillEvolutionReport } from './fleet.js';
import {
  attribute, correctedRunIds, fieldOf, groupErrors, renderMarkdown,
  type RunRow, type ToolStepRow, type UserMessage, type WeeklyReport,
} from './analysis.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 7;
const REPORT_NAME = /^weekly-(\d{4}-\d{2}-\d{2})\.json$/;

export interface EvalLog {
  info(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export interface WeeklyOptions {
  db: DurableDb;
  log: EvalLog;
  dir?: string;
  now?: () => Date;
  /** With the platform skills, the report also carries the fleet metrics and the per-version skill numbers (BACKEND §5.15). */
  platformSkills?: PlatformSkillsService;
}

// `steps` holds the step documents (tool, status, errorKind, retryOf, output.summary); `summary` is read only for the one field name
// `fieldOf` takes from it. The model comes from the run document (the model is recorded on the run, not on each step).
const STEP_SQL = `SELECT s.id AS step_id, s.run_id, s.doc->>'tool' AS tool, s.status, s.doc->>'errorKind' AS error_kind,
    s.doc->>'retryOf' AS retry_of, s.doc->'output'->>'summary' AS summary, COALESCE(r.doc->>'model', 'unknown') AS model
  FROM steps s LEFT JOIN runs r ON r.id = s.run_id
  WHERE s.at >= $1::timestamptz AND s.doc->>'tool' IS NOT NULL`;

const RUN_SQL = `SELECT r.id AS run_id, COALESCE(r.doc->>'model', 'unknown') AS model, r.conversation_id, r.at, r.doc->>'finishedAt' AS finished_at
  FROM runs r WHERE r.at >= $1::timestamptz`;

const MESSAGE_SQL = `SELECT i.conversation_id, i.at, i.doc->>'text' AS text
  FROM items i WHERE i.doc->>'type' = 'user_message' AND i.at >= $1::timestamptz ORDER BY i.conversation_id, i.at`;

type Row = Record<string, unknown>;

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const time = (value: unknown): number => new Date(value as string).getTime();

export async function buildWeeklyReport(options: WeeklyOptions): Promise<WeeklyReport> {
  const now = (options.now ?? (() => new Date()))();
  const from = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const [stepRows, runRows, messageRows] = await Promise.all([
    options.db.query<Row>(STEP_SQL, [from]),
    options.db.query<Row>(RUN_SQL, [from]),
    options.db.query<Row>(MESSAGE_SQL, [from]),
  ]);
  const runs: RunRow[] = runRows.map((row) => ({
    runId: String(row['run_id']),
    model: String(row['model']),
    ...(text(row['conversation_id']) === undefined ? {} : { conversationId: text(row['conversation_id']) }),
    startedAt: time(row['at']),
    ...(text(row['finished_at']) === undefined ? {} : { finishedAt: time(row['finished_at']) }),
  }));
  const messages: UserMessage[] = messageRows.map((row) => ({
    conversationId: String(row['conversation_id']),
    at: time(row['at']),
    text: text(row['text']) ?? '',
  }));
  const steps: ToolStepRow[] = stepRows.map((row) => {
    const errorKind = text(row['error_kind']);
    const field = fieldOf(text(row['summary']), errorKind);
    return {
      stepId: String(row['step_id']),
      runId: String(row['run_id']),
      tool: String(row['tool']),
      failed: row['status'] === 'failed',
      ...(errorKind === undefined ? {} : { errorKind }),
      ...(text(row['retry_of']) === undefined ? {} : { retryOf: text(row['retry_of']) }),
      ...(field === undefined ? {} : { field }),
      model: String(row['model']),
    };
  });
  const runsByModel: Record<string, number> = {};
  for (const run of runs) runsByModel[run.model] = (runsByModel[run.model] ?? 0) + 1;
  const corrected = correctedRunIds(runs, messages);
  return {
    generatedAt: now.toISOString(),
    from,
    to: now.toISOString(),
    runs: runs.length,
    runsByModel,
    toolSteps: steps.length,
    failedSteps: steps.filter((step) => step.failed).length,
    groups: groupErrors(steps, runsByModel),
    buckets: attribute(steps, corrected),
    correctedRunIds: corrected,
    ...(options.platformSkills === undefined ? {} : { skillEvolution: await skillEvolutionReport(options.db, options.platformSkills, now) }),
  };
}

/** Build the report and write `weekly-<date>.md` and `.json` under `<dir>/weekly/`. Returns the two paths. */
export async function writeWeeklyReport(options: WeeklyOptions): Promise<{ markdownPath: string; jsonPath: string; report: WeeklyReport }> {
  const report = await buildWeeklyReport(options);
  const folder = join(options.dir ?? evalReportsDir(), 'weekly');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const stamp = report.to.slice(0, 10);
  const markdownPath = join(folder, `weekly-${stamp}.md`);
  const jsonPath = join(folder, `weekly-${stamp}.json`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await writeFile(markdownPath, renderMarkdown(report) + (report.skillEvolution === undefined ? '' : renderSkillEvolution(report.skillEvolution).join('\n') + '\n'), { mode: 0o600 });
  options.log.info({ runs: report.runs, failedSteps: report.failedSteps, groups: report.groups.length, corrected: report.correctedRunIds.length, folder }, 'Weekly evaluation report written');
  return { markdownPath, jsonPath, report };
}

/** The newest report's day, from its file name; undefined when none has been written. */
export async function latestReportTime(dir: string): Promise<number | undefined> {
  const names = await readdir(join(dir, 'weekly')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const days = names.flatMap((name) => {
    const match = REPORT_NAME.exec(name);
    return match === null ? [] : [Date.parse(match[1] + 'T00:00:00Z')];
  });
  return days.length === 0 ? undefined : Math.max(...days);
}

const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Start the weekly job: a check a minute after boot, then every six hours; it writes a report when the newest one is a week old or missing.
 * The check reads the folder, so a restart does not write a second report in the same week. Returns the stop function.
 */
export function startWeeklyEvaluation(options: WeeklyOptions): () => void {
  const dir = options.dir ?? evalReportsDir();
  let running = false;
  const check = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const last = await latestReportTime(dir);
      if (last !== undefined && Date.now() - last < WINDOW_DAYS * DAY_MS) return;
      await writeWeeklyReport({ ...options, dir });
    } catch (error) {
      options.log.error({ err: error }, 'Weekly evaluation report failed; the next check retries it');
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void check(), FIRST_CHECK_MS);
  first.unref();
  const every = setInterval(() => void check(), CHECK_EVERY_MS);
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

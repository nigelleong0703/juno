/**
 * The nightly skill-evolution job (BACKEND §5.15), server side, in this order:
 *   1. label the runs that settled (outcomes.ts) and credit or blame the skill versions they read;
 *   2. judge every canary candidate (promote, roll back with tombstones, expire);
 *   3. reflect on the platform skills that had bad runs tonight (reflector.ts), when a reflector model is configured.
 * Rollback comes before reflection so nothing goes live without a way back, and a skill whose candidate was just decided can get the next one.
 * The report it writes holds ids, counts and reasons only (`<EVAL_REPORTS_DIR>/nightly/`, private permissions), and its file name is also the
 * "already ran today" marker, so a restart does not run it twice in one day.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DurableDb } from '@agent-desktop/durable';
import type { CandidateReview, PlatformSkillsService, SkillsService } from '@agent-desktop/memory-graph/skills';
import { evalReportsDir } from 'juno-agent/modules/evaluation/paths';
import { skillEvolutionReport, type SkillEvolutionReport } from './fleet.js';
import { labelRuns, type LabelReport } from './outcomes.js';
import { reflectNight, type Complete, type ReflectorLog, type SkillReflection } from './reflector.js';

export interface EvolutionDeps {
  db: DurableDb;
  log: ReflectorLog;
  platform: PlatformSkillsService;
  skills?: SkillsService;
  /** The reflector's model call; absent: no reflection. */
  complete?: Complete;
  dir?: string;
  now?: () => Date;
}

export interface NightlyReport {
  at: string;
  labels: Omit<LabelReport, 'runs'>;
  reviews: CandidateReview[];
  reflections: SkillReflection[];
  reflectorConfigured: boolean;
}

const NAME = /^evolve-(\d{4}-\d{2}-\d{2})\.json$/;
/** The job is due from this UTC hour until it has run for the day (and at once when it never ran). */
const DUE_FROM_UTC_HOUR = 3;
const FIRST_CHECK_MS = 2 * 60_000;
const CHECK_EVERY_MS = 60 * 60_000;

export async function runSkillEvolution(deps: EvolutionDeps): Promise<NightlyReport> {
  const now = (deps.now ?? (() => new Date()))();
  const labels = await labelRuns({ db: deps.db, platform: deps.platform, now: () => now, ...(deps.skills === undefined ? {} : { skills: deps.skills }) });
  const reviews = await deps.platform.reviewCandidates(now);
  const reflections = deps.complete === undefined
    ? []
    : await reflectNight({ db: deps.db, platform: deps.platform, complete: deps.complete, log: deps.log, now: () => now }, labels.runs);
  const { runs: _runs, ...counts } = labels;
  const report: NightlyReport = { at: now.toISOString(), labels: counts, reviews, reflections, reflectorConfigured: deps.complete !== undefined };
  const folder = join(deps.dir ?? evalReportsDir(), 'nightly');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(join(folder, `evolve-${now.toISOString().slice(0, 10)}.json`), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  deps.log.info({ labeled: counts.labeled, credited: counts.credited, reviews: reviews.length, reflected: reflections.length }, 'Skill evolution ran');
  return report;
}

async function lastRunDay(dir: string): Promise<string | undefined> {
  const names = await readdir(join(dir, 'nightly')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return names.flatMap((name) => NAME.exec(name)?.[1] ?? []).sort().at(-1);
}

/** Start the job: a check two minutes after boot, then hourly; it runs when it has not run today and it is past 03:00 UTC (or never ran). Returns stop. */
export function startSkillEvolution(deps: EvolutionDeps): () => void {
  const dir = deps.dir ?? evalReportsDir();
  let running = false;
  const check = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const now = (deps.now ?? (() => new Date()))();
      const last = await lastRunDay(dir);
      if (last === now.toISOString().slice(0, 10)) return;
      if (last !== undefined && now.getUTCHours() < DUE_FROM_UTC_HOUR) return;
      await runSkillEvolution({ ...deps, dir });
    } catch (error) {
      deps.log.error({ err: error }, 'Skill evolution failed; the next check retries it');
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

/** What the internal admin read and run-now route use. */
export interface EvolutionControl {
  report(): Promise<SkillEvolutionReport>;
  /** Run the night now. `at` stands in for the clock (operators and the e2e suite use it to settle runs that just finished). */
  runNow(at?: Date): Promise<NightlyReport>;
}

export function createEvolutionControl(deps: EvolutionDeps): EvolutionControl {
  return {
    report: () => skillEvolutionReport(deps.db, deps.platform),
    runNow: (at) => runSkillEvolution(at === undefined ? deps : { ...deps, now: () => at }),
  };
}

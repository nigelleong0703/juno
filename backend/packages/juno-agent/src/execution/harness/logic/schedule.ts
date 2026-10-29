/** Routine scheduling math (BACKEND §3.6) on croner, timezone-aware. */
import { Cron } from 'croner';
import type { Routine } from '@agent-desktop/public-contracts';

/** How late a fire may be and still count as on time (OpenBot `server/src/routines/sweep.ts`: "how late a firing may be and still be worth having", 10 minutes). */
export const FIRE_GRACE_MS = 10 * 60_000;
/** The most missed occurrences read when catching up; only the newest one runs, the rest are counted. */
export const MISSED_SCAN_MAX = 2_000;

/**
 * The idempotence key of one due occurrence: the routine and the due second in UTC (OpenBot's due-offer key stops at the minute;
 * a cron here may have a seconds field, and two occurrences inside one minute must not share a key). Two fires that
 * name the same occurrence (a retry, a re-armed timer, two workers) make the same key, so the session accepts one wake.
 */
export function dueKey(routineId: string, due: Date): string {
  return routineId + ':' + due.toISOString().slice(0, 19) + 'Z';
}

export interface FirePlan {
  /** The one occurrence that runs: the newest one that was due. */
  run?: Date;
  /** The newest occurrence was later than the grace window: the run is a catch-up. */
  late: boolean;
  /** Older occurrences that will never run (collapsed into `run`, or all that were missed while offline). */
  skipped: Date[];
}

/**
 * What to do with the occurrences that came due since the routine last fired (ascending). A fire within the grace window runs once.
 * However many were missed, at most one runs, and it is the newest: the older ones are not run "once per missed occurrence"
 * (OpenBot sweep.ts); they are reported as skipped. The newest occurrence is by construction less than one period old.
 */
export function planFire(due: readonly Date[], now: Date): FirePlan {
  const run = due.at(-1);
  if (run === undefined) return { late: false, skipped: [] };
  return { run, late: now.getTime() - run.getTime() > FIRE_GRACE_MS, skipped: due.slice(0, -1) };
}

const cronFor = (trigger: Routine['trigger']): Cron | null => {
  if (trigger.kind !== 'schedule' || !trigger.cron) return null;
  try {
    return new Cron(trigger.cron, { timezone: trigger.tz, paused: true });
  } catch {
    return null;
  }
};

const endOf = (trigger: Routine['trigger']): number | null =>
  trigger.kind === 'schedule' && trigger.endDate ? Date.parse(`${trigger.endDate}T23:59:59.999Z`) : null;

/** The next occurrence strictly after `after`, or null (no cron, invalid, or past endDate). */
export function nextRunAt(trigger: Routine['trigger'], after: Date): Date | null {
  const cron = cronFor(trigger);
  if (!cron) return null;
  const next = cron.nextRun(after);
  const end = endOf(trigger);
  if (!next || (end !== null && next.getTime() > end)) return null;
  return next;
}

/** Occurrences in [from, to] (from inclusive), at most `max` (the most recent ones are kept). */
export function missedRuns(trigger: Routine['trigger'], from: Date, to: Date, max = 1000): Date[] {
  const cron = cronFor(trigger);
  if (!cron || from.getTime() > to.getTime()) return [];
  const out: Date[] = [];
  let cursor = new Date(from.getTime() - 1);
  for (let i = 0; i < 10_000; i += 1) {
    const next = cron.nextRun(cursor);
    if (!next || next.getTime() > to.getTime()) break;
    out.push(next);
    cursor = next;
  }
  return out.slice(-max);
}

/** Minimum gap between two consecutive occurrences (for min-interval validation). */
export function minIntervalMs(trigger: Routine['trigger'], from: Date = new Date(), samples = 5): number | null {
  const cron = cronFor(trigger);
  if (!cron) return null;
  const runs = cron.nextRuns(samples + 1, from);
  let min: number | null = null;
  for (let i = 1; i < runs.length; i += 1) {
    const gap = runs[i]!.getTime() - runs[i - 1]!.getTime();
    min = min === null ? gap : Math.min(min, gap);
  }
  return min;
}

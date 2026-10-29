/**
 * H-89: routines have a minimum interval between runs, so a schedule cannot make an agent spend model
 * tokens every few seconds forever. Applies to every way a routine is created or rescheduled (the
 * public API and the agent's state_update tool). The test stack lowers it with ROUTINE_MIN_INTERVAL_MS.
 */
import { Cron } from 'croner';
import { LIMITS } from '../../../contracts/index.js';
import type { Routine } from '@agent-desktop/public-contracts';

export function minRoutineIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env['ROUTINE_MIN_INTERVAL_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : LIMITS.routine.minIntervalMinutes * 60_000;
}

/** A refusal message when the schedule fires more often than the minimum, else undefined. */
export function routineIntervalRefusal(trigger: Routine['trigger'], minMs: number = minRoutineIntervalMs(), from: Date = new Date()): string | undefined {
  if (trigger.kind !== 'schedule' || !trigger.cron) return undefined;
  let runs: Date[];
  try {
    runs = new Cron(trigger.cron, { timezone: trigger.tz, paused: true }).nextRuns(6, from);
  } catch {
    return 'the routine schedule is not a valid cron expression';
  }
  for (let i = 1; i < runs.length; i += 1) {
    const gap = (runs[i]?.getTime() ?? 0) - (runs[i - 1]?.getTime() ?? 0);
    if (gap < minMs) return 'routines may run at most once every ' + String(Math.round(minMs / 60_000)) + ' minutes';
  }
  return undefined;
}

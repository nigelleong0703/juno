/** When a goal's agent checks in (BACKEND §5.10). Pure: the tick, the tool and the routes all use these. */
import type { Goal, GoalMilestone } from '@agent-desktop/public-contracts';
import { localDate } from '../home/paths.js';

const HOUR_MS = 60 * 60 * 1000;
/** The agent may pick any time from one hour to seven days ahead; without a pick the next check is a day later. */
export const MIN_CHECK_MS = HOUR_MS;
export const DEFAULT_CHECK_MS = 24 * HOUR_MS;
export const MAX_CHECK_MS = 7 * 24 * HOUR_MS;
/** A milestone due within this long (and not done) gets one reminder. */
export const DEADLINE_WINDOW_MS = 24 * HOUR_MS;
/** The daily briefing is due from this local hour on, once per local date. */
const BRIEFING_FROM_HOUR = 6;

/** The next check time: the requested one bounded to [now + 1 h, now + 7 d], or now + 1 day when none (or an unreadable one) was given. */
export function clampNextCheck(requested: string | undefined, now: Date): string {
  const asked = requested === undefined ? Number.NaN : Date.parse(requested);
  const at = Number.isNaN(asked) ? now.getTime() + DEFAULT_CHECK_MS : asked;
  return new Date(Math.min(Math.max(at, now.getTime() + MIN_CHECK_MS), now.getTime() + MAX_CHECK_MS)).toISOString();
}

/** Active goals whose check-in time has come. Goals that are paused or done never check in. */
export function isCheckinDue(goal: Pick<Goal, 'status' | 'nextCheckAt'>, now: Date): boolean {
  return goal.status === 'active' && goal.nextCheckAt !== undefined && Date.parse(goal.nextCheckAt) <= now.getTime();
}

/** Milestones not done that fall due within 24 hours (or are past due) and have not been reminded about yet. */
export function dueDeadlines(goal: Pick<Goal, 'status' | 'milestones'>, now: Date): GoalMilestone[] {
  if (goal.status !== 'active') return [];
  return (goal.milestones ?? []).filter((milestone) => milestone.status !== 'done' && milestone.due !== undefined
    && milestone.remindedAt === undefined && Date.parse(milestone.due) <= now.getTime() + DEADLINE_WINDOW_MS);
}

/** Whether the daily briefing should be written at this tick for the user's local date. */
export function briefingDue(now: Date, timeZone: string | undefined, lastDate: string | undefined): { due: boolean; date: string } {
  const date = localDate(now, timeZone);
  let hour: number;
  try {
    hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: timeZone ?? 'UTC', hour: '2-digit', hourCycle: 'h23' }).format(now));
  } catch {
    hour = now.getUTCHours();
  }
  return { due: hour >= BRIEFING_FROM_HOUR && lastDate !== date, date };
}

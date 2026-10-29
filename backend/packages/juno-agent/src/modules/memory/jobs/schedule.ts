/** When the memory jobs run (BACKEND §5.4): hourly at a per-user minute, and the nightly one in the 3 a.m. hour of the user's clock. */
import { createHash } from 'node:crypto';
import { localDate } from '../../home/paths.js';

const HOUR_MS = 60 * 60 * 1000;
/** The nightly job is due from 3:00 until 6:00 local time (a late tick still catches the night), once per local date. */
const NIGHT_FROM = 3;
const NIGHT_UNTIL = 6;

/** The minute of the hour this user's jobs run at, spread over users so they do not all call the model at once. */
export const jobMinute = (ownerId: string): number => createHash('sha256').update(ownerId).digest().readUInt16BE(0) % 60;

/** The first hourly slot strictly after `now`. */
export function nextHourlyAt(now: Date, ownerId: string): Date {
  const slot = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS + jobMinute(ownerId) * 60_000;
  return new Date(slot > now.getTime() ? slot : slot + HOUR_MS);
}

function localHour(now: Date, timeZone: string | undefined): number {
  try {
    const hour = new Intl.DateTimeFormat('en-GB', { timeZone: timeZone ?? 'UTC', hour: '2-digit', hourCycle: 'h23' }).format(now);
    return Number(hour);
  } catch {
    return now.getUTCHours();
  }
}

/** Whether the nightly job should run at this tick, and the local date it would run for. */
export function nightlyDue(now: Date, timeZone: string | undefined, lastDate: string | undefined): { due: boolean; date: string } {
  const date = localDate(now, timeZone);
  const hour = localHour(now, timeZone);
  return { due: hour >= NIGHT_FROM && hour < NIGHT_UNTIL && lastDate !== date, date };
}

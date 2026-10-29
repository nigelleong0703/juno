/** When the daily ideas job runs (BACKEND §5.10): once a day, in the 8 a.m. hour of the user's clock, at a per-user minute. */
import { jobMinute } from '../memory/jobs/schedule.js';

const MORNING_HOUR = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Minutes to add to UTC to get the wall clock of `zone` at `at`. */
function offsetMinutes(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const n = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return (Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(at.getTime() / 1000) * 1000) / 60_000;
}

/** The next local `MORNING_HOUR:<user minute>` strictly after `now`; UTC when the zone is unknown or invalid. */
export function nextIdeasAt(now: Date, ownerId: string, timeZone?: string): Date {
  let zone = timeZone ?? 'UTC';
  try {
    offsetMinutes(now, zone);
  } catch {
    zone = 'UTC';
  }
  const minute = jobMinute(ownerId);
  for (let day = 0; day <= 2; day += 1) {
    const probe = new Date(now.getTime() + day * DAY_MS);
    const local = new Date(probe.getTime() + offsetMinutes(probe, zone) * 60_000);
    // Local midnight of that day as a UTC-labelled instant, then back to the real instant using the offset at the target.
    const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), MORNING_HOUR, minute);
    let at = new Date(wall - offsetMinutes(new Date(wall - offsetMinutes(probe, zone) * 60_000), zone) * 60_000);
    if (Number.isNaN(at.getTime())) at = new Date(wall);
    if (at.getTime() > now.getTime()) return at;
  }
  return new Date(now.getTime() + DAY_MS);
}

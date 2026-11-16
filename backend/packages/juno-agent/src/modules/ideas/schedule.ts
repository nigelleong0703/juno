/**
 * When the daily ideas job runs (BACKEND §5.10): once a day at the owner's chosen local time (settings `general.dailyCheck.time`),
 * by default in the 8 a.m. hour of their clock at a per-user minute. The setting can also switch the job off. It also decides when
 * a message the model planned (`sendAt`) really goes out: in the future, within a day and a half, and outside the quiet hours.
 */
import { settingsIdFor } from '@agent-desktop/public-contracts';
import type { Store } from '../../contracts/index.js';
import { jobMinute } from '../memory/jobs/schedule.js';

const MORNING_HOUR = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Minutes to add to UTC to get the wall clock of `zone` at `at`. */
function offsetMinutes(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const n = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return (Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(at.getTime() / 1000) * 1000) / 60_000;
}

export interface DailyCheck {
  enabled: boolean;
  /** `HH:MM` local; undefined keeps the default (08:<user minute>). */
  time?: string;
  /** Quiet hours, local `HH:MM`; a message planned inside is held until `to`. Default 23:00 to 07:30; `from` equal to `to` is none. */
  quiet: { from: string; to: string };
}

export const DEFAULT_QUIET = { from: '23:00', to: '07:30' } as const;
/** How far ahead the model may plan a message. */
export const MAX_AHEAD_MS = 36 * 60 * 60 * 1000;

/** The owner's daily-check setting; the default when they never set it (on, default time). */
export async function readDailyCheck(store: Store, ownerId: string): Promise<DailyCheck> {
  const setting = (await store.get('settings', settingsIdFor(ownerId)))?.general.dailyCheck;
  return { enabled: setting?.enabled !== false, ...(setting?.time === undefined ? {} : { time: setting.time }), quiet: setting?.quiet ?? DEFAULT_QUIET };
}

/** The local hour and minute the job runs at: the chosen `HH:MM`, else 08:<user minute>. */
function runTime(ownerId: string, time: string | undefined): { hour: number; minute: number } {
  const match = time === undefined ? null : /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return match === null ? { hour: MORNING_HOUR, minute: jobMinute(ownerId) } : { hour: Number(match[1]), minute: Number(match[2]) };
}

/** `zone` if it is a valid IANA zone, else UTC. */
function validZone(timeZone: string | undefined): string {
  const zone = timeZone ?? 'UTC';
  try {
    offsetMinutes(new Date(), zone);
    return zone;
  } catch {
    return 'UTC';
  }
}

/** The instant at which the local clock reads `hour:minute` on the local day that `probe` falls on. */
function atLocal(probe: Date, zone: string, hour: number, minute: number): Date {
  const local = new Date(probe.getTime() + offsetMinutes(probe, zone) * 60_000);
  // Local midnight of that day as a UTC-labelled instant, then back to the real instant using the offset at the target.
  const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute);
  const at = new Date(wall - offsetMinutes(new Date(wall - offsetMinutes(probe, zone) * 60_000), zone) * 60_000);
  return Number.isNaN(at.getTime()) ? new Date(wall) : at;
}

/** The next local run time (the chosen one, else `MORNING_HOUR:<user minute>`) strictly after `now`; UTC when the zone is unknown or invalid. */
export function nextIdeasAt(now: Date, ownerId: string, timeZone?: string, time?: string): Date {
  const zone = validZone(timeZone);
  const { hour, minute } = runTime(ownerId, time);
  for (let day = 0; day <= 2; day += 1) {
    const at = atLocal(new Date(now.getTime() + day * DAY_MS), zone, hour, minute);
    if (at.getTime() > now.getTime()) return at;
  }
  return new Date(now.getTime() + DAY_MS);
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm: string): number => {
  const match = HHMM.exec(hhmm);
  return match === null ? 0 : Number(match[1]) * 60 + Number(match[2]);
};

export interface PlannedSend {
  at: Date;
  /** Why the time is not what the model asked for (logged); undefined when it was used as given. */
  adjusted?: string;
}

/**
 * When a message the model planned really goes out. `sendAt` is an ISO time with an offset, or `HH:MM` in the owner's zone (the next such
 * time, today or tomorrow); none or unreadable means now. Code, not the model, enforces the bounds: a past time becomes now, one beyond
 * `MAX_AHEAD_MS` becomes the limit, and a time inside the quiet hours moves to when they end.
 */
export function planSendTime(input: { sendAt?: string; now: Date; timeZone?: string; quiet: { from: string; to: string } }): PlannedSend {
  const { now, quiet } = input;
  const zone = validZone(input.timeZone);
  const clock = input.sendAt === undefined ? null : HHMM.exec(input.sendAt.trim());
  const given = input.sendAt === undefined ? undefined : clock === null ? new Date(input.sendAt) : atLocal(now, zone, Number(clock[1]), Number(clock[2]));
  let at = given === undefined || Number.isNaN(given.getTime()) ? now : given;
  let adjusted: string | undefined = input.sendAt !== undefined && given !== undefined && Number.isNaN(given.getTime()) ? 'unreadable sendAt' : undefined;
  if (clock !== null && at.getTime() <= now.getTime()) at = atLocal(new Date(now.getTime() + DAY_MS), zone, Number(clock[1]), Number(clock[2]));
  if (at.getTime() < now.getTime()) {
    at = now;
    adjusted = 'sendAt in the past';
  } else if (at.getTime() > now.getTime() + MAX_AHEAD_MS) {
    at = new Date(now.getTime() + MAX_AHEAD_MS);
    adjusted = 'sendAt more than 36 hours ahead';
  }
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  const local = new Date(at.getTime() + offsetMinutes(at, zone) * 60_000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const quietNow = from === to ? false : from < to ? minute >= from && minute < to : minute >= from || minute < to;
  if (quietNow) {
    const end = atLocal(at, zone, Math.floor(to / 60), to % 60);
    at = end.getTime() > at.getTime() ? end : atLocal(new Date(at.getTime() + DAY_MS), zone, Math.floor(to / 60), to % 60);
    adjusted = (adjusted === undefined ? '' : adjusted + '; ') + 'inside quiet hours';
  }
  return { at, ...(adjusted === undefined ? {} : { adjusted }) };
}

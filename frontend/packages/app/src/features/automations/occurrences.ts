import type { AgentCalendarItem, Routine, RoutineRun } from "@agent-desktop/client";
import { Cron } from "croner";
import { localTimeZone } from "../routines/cron";

/** Most occurrences expanded per routine per visible range. */
export const MAX_OCCURRENCES = 200;
/** A routine firing more often than this per day shows one compact "frequent" chip instead of blocks. */
export const DENSE_PER_DAY = 6;

export interface Occurrence {
  routine: Routine;
  start: Date;
  /** Past: a recorded run. Future: a cron fire time still to come. */
  past: boolean;
  run?: RoutineRun;
}

export interface RoutineOccurrences {
  occurrences: Occurrence[];
  /** Fires too often to draw as blocks: shown as one chip per day. */
  dense: boolean;
}

export const DAY_MS = 86_400_000;

/** Start of the local day. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes());
}

/** Does the routine appear on the time grid? Schedules with a cron do; the rest go to "On demand". */
export function isTimed(routine: Routine): boolean {
  return routine.trigger.kind === "schedule" && Boolean(routine.trigger.cron?.trim());
}

/** The routine will not fire while paused, errored, waiting on an app, or switched off. */
export function dimReason(routine: Routine): "paused" | "needs_setup" | "error" | undefined {
  if (routine.status === "needs_setup") return "needs_setup";
  if (routine.status === "error") return "error";
  if (routine.status === "paused" || !routine.enabled) return "paused";
  return undefined;
}

function cronTimes(routine: Routine, from: Date, to: Date, limit: number): Date[] {
  if (routine.trigger.kind !== "schedule" || !routine.trigger.cron) return [];
  const end = routine.trigger.endDate ? new Date(`${routine.trigger.endDate}T23:59:59`) : undefined;
  try {
    const cron = new Cron(routine.trigger.cron, { timezone: routine.trigger.tz || localTimeZone(), paused: true });
    const times: Date[] = [];
    let cursor = new Date(from.getTime() - 1);
    while (times.length < limit) {
      const next = cron.nextRun(cursor);
      if (!next || next >= to || (end && next > end)) break;
      times.push(next);
      cursor = next;
    }
    return times;
  } catch {
    return [];
  }
}

/**
 * The routine's occurrences in `[from, to)`: recorded runs before `now`, cron fire times after it, in the
 * viewer's local time (the cron is evaluated in the routine's own timezone). A routine that fires more than
 * `DENSE_PER_DAY` times a day is reported `dense` with no blocks.
 */
export function expandRoutine(routine: Routine, from: Date, to: Date, now: Date = new Date()): RoutineOccurrences {
  const occurrences: Occurrence[] = [];
  for (const run of routine.runs) {
    // A skipped entry is a note about missed occurrences, not a run that happened at that time.
    if (run.status === "skipped") continue;
    const start = new Date(run.startedAt);
    if (start >= from && start < to && start <= now) occurrences.push({ routine, start, past: true, run });
  }
  const futureFrom = from > now ? from : now;
  const probe = cronTimes(routine, futureFrom, new Date(futureFrom.getTime() + DAY_MS), DENSE_PER_DAY + 1);
  if (probe.length > DENSE_PER_DAY) return { occurrences: [], dense: true };
  let future = cronTimes(routine, futureFrom, to, MAX_OCCURRENCES);
  if (future.length === 0 && !isTimed(routine) && routine.nextRunAt) {
    const next = new Date(routine.nextRunAt);
    if (next >= futureFrom && next < to) future = [next];
  }
  for (const start of future) occurrences.push({ routine, start, past: false });
  return { occurrences: occurrences.sort((a, b) => a.start.getTime() - b.start.getTime()).slice(0, MAX_OCCURRENCES), dense: false };
}

/** An item from an agent's own calendar placed on the grid. */
export interface CalendarBlock {
  item: AgentCalendarItem;
  start: Date;
  /** The agent did not get to it: drawn with an amber outline. */
  missed: boolean;
}

/** The agents' own calendar items in `[from, to)`, soonest first; cancelled ones are not shown. */
export function calendarBlocks(items: AgentCalendarItem[], from: Date, to: Date): CalendarBlock[] {
  return items
    .filter((item) => item.status !== "cancelled")
    .map((item) => ({ item, start: new Date(item.at), missed: item.status === "missed" }))
    .filter((block) => block.start >= from && block.start < to)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Weekly cron for "this weekday at this time" (clicking an empty slot). */
export function slotCron(slot: Date): string {
  return `${slot.getMinutes()} ${slot.getHours()} * * ${slot.getDay()}`;
}

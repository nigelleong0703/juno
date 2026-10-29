/**
 * Boot maintenance of the coordinator: make sure every routine, calendar item and per-user schedule has a pending timer.
 *
 * Pending timer invocations survive a restart, so this is only a "make sure one exists" scan. It belongs to the single
 * coordinator, not to the execution workers: with N workers starting (or restarting) at different times, each one
 * running the scan would race the others between "is it live?" and "arm it" and re-arm timers that already exist.
 * The arming only stores work (`runner.sendTo`), so it needs no executor and also runs in `coordinator` role.
 */
import type { Runner } from '@agent-desktop/durable';
import type { Enqueuer, Store } from '@agent-desktop/contracts';
import { RESTATE } from '@agent-desktop/contracts';
import { docOwner } from 'juno-agent/execution/execution-owner';
import { createLogger } from '@agent-desktop/log';

const log = createLogger({ service: 'agentd-execution' });

export async function armMissingTimers(opts: { store: Store; runner: Runner; enqueuer: Enqueuer }): Promise<void> {
  const { store, runner, enqueuer } = opts;
  try {
    let cursor: string | undefined;
    for (;;) {
      const page = await store.list('routines', { limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      for (const routine of page.items) {
        if (!routine.enabled) continue;
        try {
          if (!(await runner.isLive(RESTATE.routineTimer, routine.id, 'fire'))) await enqueuer.scheduleRoutine(routine.id);
        } catch (error) {
          log.warn({ err: error, routineId: routine.id }, 'Failed to arm routine');
        }
      }
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    // Scheduled items of the agents' own calendars.
    for (let calendarCursor: string | undefined; ; ) {
      const page = await store.list('agentCalendar', { where: { status: 'scheduled' }, limit: 100, ...(calendarCursor === undefined ? {} : { cursor: calendarCursor }) });
      for (const item of page.items) {
        try {
          if (!(await runner.isLive(RESTATE.calendarTimer, item.id, 'fire'))) await enqueuer.scheduleCalendarItem?.(item.id);
        } catch (error) {
          log.warn({ err: error, itemId: item.id }, 'Failed to arm calendar item');
        }
      }
      if (page.nextCursor === undefined) break;
      calendarCursor = page.nextCursor;
    }
    // Every user who has an agent gets their hidden memory schedule.
    const owners = new Set<string>();
    for (let agentCursor: string | undefined; ; ) {
      const page = await store.list('agents', { limit: 100, ...(agentCursor === undefined ? {} : { cursor: agentCursor }) });
      for (const row of page.items) {
        const owner = docOwner(row);
        if (owner !== undefined) owners.add(owner);
      }
      if (page.nextCursor === undefined) break;
      agentCursor = page.nextCursor;
    }
    for (const owner of owners) {
      const memory = await runner.isLive(RESTATE.memoryTimer, owner, 'fire');
      const ideas = await runner.isLive(RESTATE.ideasTimer, owner, 'fire');
      if (!memory || !ideas) await enqueuer.scheduleMemoryJobs?.(owner);
    }
  } catch (error) {
    log.warn({ err: error }, 'Error starting routines');
  }
}

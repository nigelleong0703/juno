/**
 * CalendarTimer Virtual Object: one per item of an agent's own calendar (key = item id). `arm` (re)starts a durable delayed
 * `fire` at the item's time and bumps a generation, so a cancel or a move makes the earlier fire a no-op. `fire` wakes the agent
 * once with a `calendar_due` wake (the wake id is the item and its time, so a retry never wakes twice) and marks the item
 * `done`, or `missed` when the wake is later than the grace window (the engine or app was off).
 */
import { object, rpc, type ObjectContext } from '@agent-desktop/durable';
import type { Store } from '../../../contracts/index.js';
import { inOwnerScope, docOwner } from '../../execution-owner.js';
import { buildCalendarWake, CALENDAR_GRACE_MS } from '../../../modules/calendar/index.js';
import { calendarTimerDef, sessionDef, type SessionDef } from './definitions.js';

type CalendarTimerDef = typeof calendarTimerDef;

interface TimerState {
  generation: number;
  armed: boolean;
}

export const createCalendarTimerHandlers = (services: { store: Store }) => ({
    /** Starts, moves or stops the timer to match the stored item. Calling it again is harmless. */
    async arm(ctx: ObjectContext): Promise<void> {
      const state = (await ctx.get<TimerState>('state')) ?? { generation: 0, armed: false };
      const item = await ctx.run('calendar-item', () => services.store.get('agentCalendar', ctx.key));
      state.generation += 1;
      if (item === null || item.status !== 'scheduled') {
        state.armed = false;
        ctx.set('state', state);
        return;
      }
      const now = await ctx.date.now();
      state.armed = true;
      ctx.objectSendClient<CalendarTimerDef>(calendarTimerDef, ctx.key).fire({ generation: state.generation }, rpc.sendOpts({ delay: Math.max(0, Date.parse(item.at) - now) }));
      ctx.set('state', state);
    },

    async fire(ctx: ObjectContext, params: { generation: number }): Promise<void> {
      const state = (await ctx.get<TimerState>('state')) ?? { generation: 0, armed: false };
      if (params.generation !== state.generation || !state.armed) return;
      const item = await ctx.run('calendar-item', () => services.store.get('agentCalendar', ctx.key));
      state.armed = false;
      ctx.set('state', state);
      if (item === null || item.status !== 'scheduled') return;
      const ownerId = docOwner(item);
      if (ownerId === undefined) return;
      const now = new Date(await ctx.date.now());
      const missed = now.getTime() - Date.parse(item.at) > CALENDAR_GRACE_MS;
      const wake = await ctx.run('calendar-wake', () => inOwnerScope(ownerId, () => buildCalendarWake(services.store, item, now, missed)));
      if (wake === undefined) {
        await ctx.run('calendar-gone', () => services.store.patch('agentCalendar', item.id, { status: 'missed', result: 'The agent or its chat no longer exists.', updatedAt: now.toISOString() }));
        return;
      }
      ctx.objectSendClient<SessionDef>(sessionDef, wake.sessionKey).receive(wake);
      await ctx.run('calendar-mark', () => services.store.patch('agentCalendar', item.id, {
        status: missed ? 'missed' : 'done',
        ...(missed ? { result: 'Woke late, after its time had passed; the agent decided what to do.' } : {}),
        updatedAt: now.toISOString(),
      }));
    },
});

export const createCalendarTimerService = (services: { store: Store }) => object({
  name: 'CalendarTimer',
  handlers: createCalendarTimerHandlers(services),
});

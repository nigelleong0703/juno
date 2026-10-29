/** The agent's own calendar: tools arm the timer, a due fire wakes once and marks done, cancel disarms, a late fire is missed. */
import { describe, expect, it } from 'vitest';
import type { ObjectContext } from '@agent-desktop/durable';
import type { Store, Tool } from '../../../contracts/index.js';
import { createMemoryStore } from '../../../testing/store.js';
import { toolContext } from '../../../execution/brain/__tests__/agent-resources.fixtures.js';
import { createCalendarTools } from '../../tools/tools/calendarTools.js';
import { createCalendarTimerHandlers } from '../../../execution/harness/services/calendar-timer.js';
import { calendarLine } from '../index.js';

const OWNER = 'owner-1';
const tools = Object.fromEntries(createCalendarTools().map((t) => [t.name, t])) as Record<string, Tool>;

function setup() {
  const mem = createMemoryStore();
  const store: Store = mem.forOwner?.(OWNER) ?? mem;
  const armed: string[] = [];
  const ctx = { ...toolContext(store, 'agent-a'), enqueuer: { scheduleCalendarItem: async (id: string) => { armed.push(id); } } as never };
  return { store, armed, ctx };
}

async function call(name: string, ctx: ReturnType<typeof setup>['ctx'], args: unknown) {
  const result = await tools[name]!.execute(args, ctx);
  const part = result.content[0];
  return { text: part?.type === 'text' ? part.text : '', isError: result.isError === true };
}

const future = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

function timerCtx(key: string, nowMs: number) {
  const state = new Map<string, unknown>();
  const sent: Array<{ handler: string; payload: unknown }> = [];
  const ctx = {
    key,
    date: { now: async () => nowMs },
    run: async (_n: string, action: () => Promise<unknown>) => action(),
    get: async (n: string) => state.get(n),
    set: (n: string, v: unknown) => { state.set(n, v); },
    objectSendClient: () => ({
      fire: (p: unknown) => { sent.push({ handler: 'fire', payload: p }); },
      receive: (p: unknown) => { sent.push({ handler: 'receive', payload: p }); },
    }),
  } as unknown as ObjectContext;
  return { ctx, sent };
}

describe('agent calendar tools', () => {
  it('adds an item, arms its timer, lists it, moves it and cancels it', async () => {
    const { store, armed, ctx } = setup();
    const added = await call('schedule_add', ctx, { kind: 'follow_up', title: 'Ask Sam about the quote', at: future(24), instructions: 'Message Sam and ask.' });
    expect(added.isError).toBe(false);
    const [item] = (await store.list('agentCalendar')).items;
    expect(item).toMatchObject({ agentId: 'agent-a', ownerId: OWNER, status: 'scheduled', kind: 'follow_up' });
    expect(armed).toEqual([item!.id]);
    expect((await call('schedule_list', ctx, {})).text).toContain(item!.id);
    expect((await call('schedule_get', ctx, { id: item!.id })).text).toContain('Instructions: Message Sam and ask.');
    expect((await call('schedule_get', ctx, { id: 'nope' })).isError).toBe(true);
    expect((await call('schedule_add', ctx, { kind: 'task', title: 't', at: '2020-01-01T00:00:00Z', instructions: 'x' })).isError).toBe(true);

    expect((await call('schedule_update',ctx, { id: item!.id, at: future(48) })).isError).toBe(false);
    expect(armed).toHaveLength(2);
    expect((await call('schedule_cancel', ctx, { id: item!.id })).isError).toBe(false);
    expect((await store.get('agentCalendar', item!.id))?.status).toBe('cancelled');
    expect(armed).toHaveLength(3);
    expect((await call('schedule_cancel', ctx, { id: item!.id })).isError).toBe(true);
  });

  it('puts the next scheduled items in the calendar line', async () => {
    const { store, ctx } = setup();
    await call('schedule_add', ctx, { kind: 'meeting', title: 'Standup', at: future(3), instructions: 'Join.' });
    expect(await calendarLine(store, 'agent-a', new Date(), 'UTC')).toContain('"Standup"');
    expect(await calendarLine(store, 'agent-b', new Date(), 'UTC')).toBe('');
  });
});

describe('CalendarTimer', () => {
  async function seeded() {
    const s = setup();
    await s.store.put('agents', { id: 'agent-a', ownerId: OWNER, name: 'A' } as never);
    await call('schedule_add', s.ctx, { kind: 'follow_up', title: 'Follow up', at: future(1), instructions: 'Do it.' });
    const item = (await s.store.list('agentCalendar')).items[0]!;
    return { ...s, item, handlers: createCalendarTimerHandlers({ store: s.store }) };
  }

  it('wakes once at the time, marks the item done, and ignores a stale generation', async () => {
    const { store, item, handlers } = await seeded();
    const at = Date.parse(item.at);
    const { ctx, sent } = timerCtx(item.id, at - 60_000);
    await handlers.arm(ctx);
    expect(sent.map((s) => s.handler)).toEqual(['fire']);
    const state = (await ctx.get<{ generation: number }>('state'))!;
    const due = timerCtx(item.id, at + 1000);
    await due.ctx.set('state', { generation: state.generation, armed: true });
    await handlers.fire(due.ctx, { generation: state.generation + 5 });
    expect(due.sent).toHaveLength(0);
    await handlers.fire(due.ctx, { generation: state.generation });
    expect(due.sent).toHaveLength(1);
    expect(due.sent[0]!.payload).toMatchObject({ kind: 'calendar_due', trusted: true, payload: { itemId: item.id, missed: false } });
    expect((await store.get('agentCalendar', item.id))?.status).toBe('done');
  });

  it('marks a very late wake missed, and a cancelled item neither arms nor wakes', async () => {
    const { store, item, handlers } = await seeded();
    const late = timerCtx(item.id, Date.parse(item.at) + 3 * 3_600_000);
    await late.ctx.set('state', { generation: 1, armed: true });
    await handlers.fire(late.ctx, { generation: 1 });
    expect(late.sent[0]!.payload).toMatchObject({ payload: { missed: true } });
    expect((await store.get('agentCalendar', item.id))?.status).toBe('missed');

    const second = await seeded();
    await second.store.patch('agentCalendar', second.item.id, { status: 'cancelled' });
    const t = timerCtx(second.item.id, Date.parse(second.item.at) - 1000);
    await second.handlers.arm(t.ctx);
    expect(t.sent).toHaveLength(0);
    await t.ctx.set('state', { generation: 1, armed: true });
    await second.handlers.fire(t.ctx, { generation: 1 });
    expect(t.sent).toHaveLength(0);
  });
});

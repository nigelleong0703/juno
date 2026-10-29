/** The agent's own calendar REST: owner-scoped reads, edit and cancel re-arm the timer. */
import { describe, expect, it } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '@agent-desktop/db';
import { agentCalendarItemSchema, type AgentCalendarItem } from '@agent-desktop/public-contracts';
import { createTestApp, ownerHeaders } from '../../__tests__/test-app.js';

const item = (id: string, owner: string, at: string): AgentCalendarItem & { ownerId: string } => ({
  id, ownerId: owner, agentId: 'agent-1', kind: 'follow_up', title: id, at, timezone: 'UTC', instructions: 'do it',
  status: 'scheduled', createdAt: at, updatedAt: at,
});
const FUTURE = '2099-01-01T00:00:00.000Z';

async function setup() {
  const mem = createMemoryStore();
  const scoped = (o: string) => mem.forOwner!(o);
  await scoped('owner-a').put('agents', { id: 'agent-1', ownerId: 'owner-a', name: 'A' } as never);
  await scoped('owner-a').put('agentCalendar', item('c1', 'owner-a', '2099-01-02T00:00:00.000Z'));
  await scoped('owner-a').put('agentCalendar', item('c2', 'owner-a', FUTURE));
  await scoped('owner-b').put('agentCalendar', item('c3', 'owner-b', FUTURE));
  const enqueuer = new NoopEnqueuer();
  return { app: createTestApp({ store: mem, bus: mem.eventBus, enqueuer }), enqueuer };
}

describe('agent calendar routes', () => {
  it('lists only the caller\'s items soonest first, per agent and across agents', async () => {
    const { app } = await setup();
    const all = await (await app.request('/v1/calendar', { headers: ownerHeaders('owner-a', true) })).json() as { items: unknown[] };
    expect(agentCalendarItemSchema.array().parse(all.items).map((i) => i.id)).toEqual(['c2', 'c1']);
    const other = await (await app.request('/v1/calendar', { headers: ownerHeaders('owner-b', true) })).json() as { items: Array<{ id: string }> };
    expect(other.items.map((i) => i.id)).toEqual(['c3']);
    expect((await app.request('/v1/agents/agent-1/calendar', { headers: ownerHeaders('owner-a', true) })).status).toBe(200);
    expect((await app.request('/v1/agents/agent-1/calendar', { headers: ownerHeaders('owner-b', true) })).status).toBe(404);
  });

  it('edits and cancels the owner\'s item, re-arms, and hides other owners\' items', async () => {
    const { app, enqueuer } = await setup();
    const headers = { ...ownerHeaders('owner-a', true), 'content-type': 'application/json' };
    const moved = await app.request('/v1/calendar/c1', { method: 'PATCH', headers, body: JSON.stringify({ title: 'New', at: '2099-02-01T00:00:00.000Z' }) });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ title: 'New', at: '2099-02-01T00:00:00.000Z' });
    const cancelled = await app.request('/v1/calendar/c1', { method: 'DELETE', headers });
    expect(await cancelled.json()).toMatchObject({ status: 'cancelled' });
    expect(enqueuer.calls.filter((c) => c.method === 'scheduleCalendarItem')).toHaveLength(2);
    expect((await app.request('/v1/calendar/c3', { method: 'DELETE', headers })).status).toBe(404);
    expect((await app.request('/v1/calendar/c2', { method: 'PATCH', headers, body: JSON.stringify({ status: 'done' }) })).status).toBe(400);
  });
});

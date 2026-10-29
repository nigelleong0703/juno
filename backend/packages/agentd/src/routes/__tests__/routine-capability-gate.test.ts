/**
 * The capability gate through agentd's HTTP surface (BACKEND §3.6.1): POST /v1/routines with `requires` stores needs_setup and
 * raises the Connect card; POST /v1/capabilities/recheck (what the API calls after a connect/disconnect) starts the routine,
 * resolves the card and wakes the agent; the owner's edits and toggles keep the state in line; a dismissed card is not an agent wake.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { type Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Store, WakeEvent } from '@agent-desktop/contracts';
import type { Request as ConnectRequest, Routine } from '@agent-desktop/public-contracts';
import { createTestApp, requestAs, withDefaultOwner } from '../../__tests__/test-app.js';

const OWNER = 'owner-a';
const NOW = new Date().toISOString();

let store: Store;
let app: Hono;
let wakes: WakeEvent[];
let scheduled: string[];
const as = (path: string, init: { method?: string; body?: unknown } = {}) => requestAs(app, OWNER, path, init);

const body = { name: 'Morning brief', agentId: 'agt-1', instructions: 'Brief me', trigger: { kind: 'schedule', cron: '0 8 * * *', human: 'Daily 8:00', tz: 'UTC' }, delivery: { channel: 'chat', target: 'conv-1' }, requires: [{ capability: 'calendar', options: ['google-calendar', 'outlook'] }] };
const connect = (id: string, catalogId: string, extra: object = {}) => store.put('connections', { id, kind: 'mcp', name: 'Google Calendar', status: 'connected', catalogId, ...extra } as never);

beforeEach(async () => {
  const mem = createMemoryStore();
  store = withDefaultOwner(mem, OWNER);
  wakes = [];
  scheduled = [];
  const enqueuer = { async enqueue(event: WakeEvent) { wakes.push(event); return { accepted: true }; }, async stopRun() {}, async resolveAwakeable() {}, async scheduleRoutine(id: string) { scheduled.push(id); } } as never;
  app = createTestApp({ store, bus: mem.eventBus, enqueuer, config: { SEARCH_PROVIDER: 'exa' } as never });
  await store.put('agents', { id: 'agt-1', name: 'Mira', handle: 'mira', createdBy: OWNER, pluginIds: [], createdAt: NOW, updatedAt: NOW } as never);
  await store.put('conversations', { id: 'conv-1', kind: 'direct', agentIds: ['agt-1'], memberIds: [OWNER], unreadCount: 0, lastItemAt: NOW, createdAt: NOW } as never);
});

const create = async (input: object = body): Promise<Routine> => (await (await as('/v1/routines', { method: 'POST', body: input })).json()) as Routine;
const pending = async () => (await store.list('requests')).items.filter((r) => r.status === 'pending') as ConnectRequest[];

describe('routine create with requires', () => {
  it('stores needs_setup with what is missing and one Connect card in the delivery chat', async () => {
    const routine = await create();
    expect(routine).toMatchObject({ status: 'needs_setup', requires: body.requires, missing: [{ capability: 'calendar', label: 'Google Calendar or Outlook' }] });
    expect(await pending()).toMatchObject([{ kind: 'connect', conversationId: 'conv-1', payload: { appIds: ['google-calendar', 'outlook'], routineId: routine.id } }]);
  });

  it('is active with no card when the owner already has one option; web search counts from the deployment config', async () => {
    await connect('c1', 'outlook');
    const routine = await create({ ...body, requires: [...body.requires, { capability: 'web_search', options: ['web_search'] }] });
    expect(routine.status).toBe('active');
    expect(await pending()).toHaveLength(0);
    expect((await create({ ...body, requires: [{ capability: 'computer', options: ['computer'] }] })).status).toBe('needs_setup');
  });

  it('refuses a malformed requirement', async () => {
    expect((await as('/v1/routines', { method: 'POST', body: { ...body, requires: [{ capability: 'calendar', options: [] }] } })).status).toBe(400);
  });
});

describe('a webhook cannot run a routine that is waiting for setup', () => {
  it('answers 409 without waking the agent, and runs it again once connected', async () => {
    const routine = await create();
    const hook = () => as(`/v1/hooks/${routine.id}`, { method: 'POST', body: { type: 'ping' } });
    expect((await hook()).status).toBe(409);
    expect(wakes).toHaveLength(0);
    await connect('c1', 'google-calendar');
    await as('/v1/capabilities/recheck', { method: 'POST' });
    wakes.length = 0;
    expect((await hook()).status).toBe(202);
    expect(wakes.map((wake) => wake.kind)).toEqual(['webhook']);
  });
});

describe('connection changes (POST /v1/capabilities/recheck)', () => {
  it('starts the waiting routine, closes the card and wakes the agent; a later disconnect holds it again, once', async () => {
    const routine = await create();
    await connect('c1', 'google-calendar');
    const recheck = await as('/v1/capabilities/recheck', { method: 'POST' });
    expect(await recheck.json()).toEqual({ ready: [routine.id], lost: [] });
    expect(await store.get('routines', routine.id)).toMatchObject({ status: 'active' });
    expect(await pending()).toHaveLength(0);
    expect(wakes).toMatchObject([{ kind: 'capability_ready', agentId: 'agt-1', conversationId: 'conv-1', ownerId: OWNER, payload: { routineId: routine.id, connector: 'Google Calendar' } }]);
    expect(scheduled.filter((id) => id === routine.id).length).toBe(2);

    await store.patch('connections', 'c1', { status: 'disconnected', enabled: false });
    expect(await (await as('/v1/capabilities/recheck', { method: 'POST' })).json()).toEqual({ ready: [], lost: [routine.id] });
    await as('/v1/capabilities/recheck', { method: 'POST' });
    expect(wakes.map((wake) => wake.kind)).toEqual(['capability_ready', 'capability_lost']);
    expect(await pending()).toHaveLength(1);
  });

  it('only looks at the caller\'s own routines and connections', async () => {
    await create();
    await store.put('connections', { id: 'theirs', kind: 'mcp', name: 'Google Calendar', status: 'connected', catalogId: 'google-calendar', ownerId: 'owner-b' } as never);
    expect(await (await as('/v1/capabilities/recheck', { method: 'POST' })).json()).toEqual({ ready: [], lost: [] });
  });
});

describe('the owner changes the routine', () => {
  it('re-enabling keeps a routine that still lacks its app on hold, and clearing requires releases it', async () => {
    const routine = await create();
    await as(`/v1/routines/${routine.id}/toggle`, { method: 'POST', body: { enabled: false } });
    const enabled = (await (await as(`/v1/routines/${routine.id}/toggle`, { method: 'POST', body: { enabled: true } })).json()) as Routine;
    expect(enabled).toMatchObject({ enabled: true, status: 'needs_setup' });
    const released = (await (await as(`/v1/routines/${routine.id}`, { method: 'PATCH', body: { requires: [] } })).json()) as Routine;
    expect(released.status).toBe('active');
    expect(released.missing).toBeUndefined();
    expect(await pending()).toHaveLength(0);
    expect(wakes).toHaveLength(0);
  });

  it('dismissing the card is allowed and does not wake the agent; deleting the routine closes it', async () => {
    const routine = await create();
    const [card] = await pending();
    expect((await as(`/v1/requests/${card?.id}/resolve`, { method: 'POST', body: { action: 'deny' } })).status).toBe(200);
    expect(wakes).toHaveLength(0);
    const again = await create();
    await as(`/v1/routines/${again.id}`, { method: 'DELETE' });
    expect((await store.list('requests')).items.find((r) => r.kind === 'connect' && r.payload.kind === 'connect' && r.payload.routineId === again.id)?.status).toBe('expired');
    expect(routine.id).not.toBe(again.id);
  });
});

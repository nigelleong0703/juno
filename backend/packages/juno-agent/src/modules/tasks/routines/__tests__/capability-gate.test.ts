/**
 * The capability gate (BACKEND §3.6.1): a routine that declares what it needs is stored as needs_setup while the owner lacks it,
 * a Connect card appears in the agent's chat, connecting the app starts the routine and wakes the agent, and losing the app
 * puts it on hold once. Runs the real tool, gate and timer handlers over the in-memory store.
 */
import { createMemoryBlobStore } from '../../../../testing/blobs.js';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ObjectContext } from '@agent-desktop/durable';
import type { Connection, Routine } from '@agent-desktop/public-contracts';
import type { ToolContext, WakeEvent } from '../../../../contracts/index.js';
import { createMemoryStore } from '../../../../testing/store.js';
import { RecordingEnqueuer } from '../../../../execution/testing/enqueuer.js';
import { createStateUpdateTool } from '../../../tools/tools/stateUpdate.js';
import { createRoutineTimerHandlers } from '../../../../execution/harness/services/routineTimer.js';
import { inOwnerScope } from '../../../../execution/execution-owner.js';
import { optionMet, parseRequires } from '../capabilities.js';
import { reconcileOwner } from '../capability-gate.js';

const OWNER = 'user-1';
const NOW = '2026-10-16T00:00:00.000Z';
const CALENDAR = { calendar: ['google-calendar', 'outlook'] };

let store: ReturnType<typeof createMemoryStore>;
let enqueuer: RecordingEnqueuer;
let capabilities = { webSearch: true, computer: false };

const connection = (id: string, catalogId: string, name: string, extra: Partial<Connection> = {}) =>
  store.put('connections', Object.assign({ id, name, kind: 'mcp' as const, status: 'connected' as const, catalogId, ownerId: OWNER }, extra) as never);

function toolContext(): ToolContext {
  return {
    ownerId: OWNER, agentId: 'agent-1', conversationId: 'conv-1', runId: 'run-1', store, blobs: createMemoryBlobStore(), enqueuer, step: async (_name, fn) => fn(), signal: new AbortController().signal,
    wake: { id: 'wke_1', ownerId: OWNER, agentId: 'agent-1', sessionKey: 'agent-1:conv-1', conversationId: 'conv-1', kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, at: NOW, status: 'accepted' } as WakeEvent,
  };
}

const createRoutine = (requires: unknown) =>
  inOwnerScope(OWNER, () => createStateUpdateTool({ store, enqueuer, capabilities }).execute({ target: 'routine', action: 'create', name: 'Morning brief', prompt: 'Brief me on my day', schedule: '0 8 * * *', requires }, toolContext()));

const routines = async (): Promise<Routine[]> => (await store.list('routines')).items;
const gate = (opts: { routineId?: string; wake?: boolean } = {}) => inOwnerScope(OWNER, () => reconcileOwner({ store, enqueuer, capabilities }, OWNER, opts));
const wakes = (): WakeEvent[] => enqueuer.calls.filter((call) => call.method === 'enqueue').map((call) => call.args[0] as WakeEvent);

beforeEach(async () => {
  store = createMemoryStore();
  enqueuer = new RecordingEnqueuer(store);
  capabilities = { webSearch: true, computer: false };
  await store.put('agents', { id: 'agent-1', name: 'Mira', createdBy: OWNER, ownerId: OWNER, pluginIds: [] } as never);
  await store.put('conversations', { id: 'conv-1', kind: 'direct', agentIds: ['agent-1'], memberIds: [OWNER], unreadCount: 0, lastItemAt: NOW, createdAt: NOW, ownerId: OWNER } as never);
});

describe('requires', () => {
  it('reads the loose forms the model writes into any-of requirements', () => {
    expect(parseRequires([CALENDAR, 'web_search', { capability: 'mail', options: ['Gmail'] }, 'notion'])).toEqual({
      ok: true,
      requires: [{ capability: 'calendar', options: ['google-calendar', 'outlook'] }, { capability: 'web_search', options: ['web_search'] }, { capability: 'mail', options: ['gmail'] }, { capability: 'notion', options: ['notion'] }],
    });
    expect(parseRequires({ calendar: ['google-calendar'], mail: 'gmail' })).toMatchObject({ ok: true, requires: [{ capability: 'calendar' }, { capability: 'mail', options: ['gmail'] }] });
    expect(parseRequires(undefined)).toEqual({ ok: true, requires: [] });
    expect(parseRequires([{ calendar: [] }])).toMatchObject({ ok: false });
    expect(parseRequires([42])).toMatchObject({ ok: false });
  });
});

describe('creating a routine that needs an app the owner has not connected', () => {
  it('stores it as needs_setup with what is missing, adds a Connect card to the chat and tells the agent exactly what to say', async () => {
    const result = await createRoutine([CALENDAR]);
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result.content)).toMatch(/needs_setup[^]*Google Calendar or Outlook/);
    const [routine] = await routines();
    expect(routine).toMatchObject({ status: 'needs_setup', enabled: true, requires: [{ capability: 'calendar', options: ['google-calendar', 'outlook'] }], missing: [{ capability: 'calendar', options: ['google-calendar', 'outlook'], label: 'Google Calendar or Outlook' }] });
    const requests = (await store.list('requests')).items;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: 'connect', status: 'pending', agentId: 'agent-1', conversationId: 'conv-1', payload: { kind: 'connect', appIds: ['google-calendar', 'outlook'], problems: { 'google-calendar': 'not_added', outlook: 'not_added' }, label: 'Google Calendar or Outlook', routineId: routine?.id } });
    expect((await store.list('items')).items.some((item) => item.type === 'request' && item.requestId === requests[0]?.id)).toBe(true);
  });

  it('an app that is added but turned off for this agent holds the routine too, and the card says to turn it on (not to connect)', async () => {
    await connection('c1', 'google-calendar', 'Google Calendar');
    await store.put('agentApps', { id: 'agent-1:google-calendar', ownerId: OWNER, agentId: 'agent-1', appId: 'google-calendar', enabled: false, actionsPolicy: 'ask', updatedAt: NOW });
    await createRoutine([{ calendar: ['google-calendar'] }]);
    expect((await routines())[0]).toMatchObject({ status: 'needs_setup', missing: [{ label: 'Google Calendar' }] });
    expect((await store.list('requests')).items[0]).toMatchObject({ payload: { appIds: ['google-calendar'], problems: { 'google-calendar': 'not_enabled' } } });
    // Turning it on resolves the card and starts the routine.
    await store.put('agentApps', { id: 'agent-1:google-calendar', ownerId: OWNER, agentId: 'agent-1', appId: 'google-calendar', enabled: true, actionsPolicy: 'ask', updatedAt: NOW });
    expect(await gate()).toMatchObject({ ready: [(await routines())[0]!.id] });
  });

  it('an app whose sign-in expired is missing, with the reason expired', async () => {
    await connection('c1', 'google-calendar', 'Google Calendar', { status: 'error', connectedAt: NOW });
    await createRoutine([{ calendar: ['google-calendar'] }]);
    expect((await routines())[0]).toMatchObject({ status: 'needs_setup' });
    expect((await store.list('requests')).items[0]).toMatchObject({ payload: { problems: { 'google-calendar': 'expired' } } });
  });

  it('does not count a connection that is switched off, and stores the routine active once one option is really connected', async () => {
    await connection('c0', 'google-calendar', 'Google Calendar', { enabled: false });
    await createRoutine([CALENDAR]);
    expect((await routines())[0]).toMatchObject({ status: 'needs_setup' });
    await store.delete('routines', (await routines())[0]!.id);
    await connection('c1', 'outlook', 'Outlook');
    await createRoutine([CALENDAR, 'web_search']);
    expect((await routines())[0]).toMatchObject({ status: 'active', requires: [{ capability: 'calendar' }, { capability: 'web_search' }] });
    expect((await routines())[0]?.missing).toBeUndefined();
    expect((await store.list('requests')).items.filter((r) => r.status === 'pending')).toHaveLength(1);
  });

  it('holds a routine that needs a computer the platform does not have, without a Connect card (nothing to connect)', async () => {
    await createRoutine(['computer']);
    expect((await routines())[0]).toMatchObject({ status: 'needs_setup', missing: [{ capability: 'computer', label: 'A computer' }] });
    expect((await store.list('requests')).items).toHaveLength(0);
  });
});

describe('connecting the app', () => {
  it('starts the routine, resolves the card and wakes the agent once with the instruction to verify and offer a preview', async () => {
    await createRoutine([CALENDAR]);
    const id = (await routines())[0]!.id;
    expect(await gate()).toEqual({ ready: [], lost: [] });
    await connection('c1', 'google-calendar', 'Google Calendar');
    expect(await gate()).toEqual({ ready: [id], lost: [] });

    expect((await routines())[0]).toMatchObject({ status: 'active' });
    expect((await routines())[0]?.missing).toBeUndefined();
    expect((await store.list('requests')).items[0]).toMatchObject({ status: 'approved', decision: { mode: 'auto' } });
    expect(enqueuer.calls.filter((call) => call.method === 'scheduleRoutine' && call.args[0] === id).length).toBeGreaterThanOrEqual(2);
    expect(wakes()).toHaveLength(1);
    expect(wakes()[0]).toMatchObject({ kind: 'capability_ready', trusted: true, origin: { type: 'system' }, agentId: 'agent-1', conversationId: 'conv-1', payload: { routineId: id, connector: 'Google Calendar' } });
    expect(wakes()[0]?.payload['text']).toBe("Google Calendar is now connected; your routine 'Morning brief' can run. Verify with one real call, then tell the user it's ready and offer a preview run.");

    await gate();
    expect(wakes()).toHaveLength(1);
  });

  it('keeps waiting while only part of what it needs is there', async () => {
    await createRoutine([CALENDAR, 'notion']);
    await connection('c1', 'outlook', 'Outlook');
    await gate();
    expect((await routines())[0]).toMatchObject({ status: 'needs_setup', missing: [{ capability: 'notion', label: 'Notion' }] });
    expect(wakes()).toHaveLength(0);
  });
});

describe('losing the app', () => {
  it('puts an active routine on hold with one card and one wake, however often it is checked', async () => {
    await connection('c1', 'google-calendar', 'Google Calendar');
    await createRoutine([CALENDAR]);
    const id = (await routines())[0]!.id;
    expect(await gate()).toEqual({ ready: [], lost: [] });

    await store.patch('connections', 'c1', { status: 'error' });
    expect(await gate()).toEqual({ ready: [], lost: [id] });
    expect(await gate()).toEqual({ ready: [], lost: [] });
    expect((await routines())[0]).toMatchObject({ status: 'needs_setup', missing: [{ label: 'Google Calendar or Outlook' }] });
    expect((await store.list('requests')).items.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(wakes().map((wake) => wake.kind)).toEqual(['capability_lost']);
    expect(wakes()[0]?.payload['text']).toMatch(/no longer connected[^]*on hold/);
  });

  it('an owner\'s edit changes the state without waking the agent, and a disabled routine is left alone', async () => {
    await connection('c1', 'google-calendar', 'Google Calendar');
    await createRoutine([CALENDAR]);
    await store.patch('connections', 'c1', { enabled: false });
    await gate({ wake: false });
    expect((await routines())[0]).toMatchObject({ status: 'needs_setup' });
    expect(wakes()).toHaveLength(0);
    await store.patch('routines', (await routines())[0]!.id, { enabled: false });
    await connection('c2', 'google-calendar', 'Google Calendar 2');
    await gate();
    expect((await routines())[0]).toMatchObject({ status: 'needs_setup', enabled: false });
  });
});

describe('the routine timer', () => {
  const ctx = (state: Map<string, unknown>, received: unknown[]) => ({
    key: 'rtn-1', date: { now: async () => Date.parse(NOW) }, run: async (_n: string, action: () => Promise<unknown>) => action(),
    get: async (name: string) => state.get(name), set: (name: string, value: unknown) => state.set(name, value),
    objectSendClient: () => ({ arm: () => undefined, fire: () => undefined, receive: (event: unknown) => received.push(event) }),
    objectClient: () => ({ getState: async () => ({}) }),
  }) as unknown as ObjectContext;
  const timerState = () => new Map<string, unknown>([['state', { routineId: 'rtn-1', armed: true, armGeneration: 0, nextRunAtTime: NOW, failStreak: 0, unreadStreak: 0, firedOccurrences: [], lastFiredAt: '2026-10-15T12:00:00.000Z' }]]);
  const row = (extra: Partial<Routine>) => store.put('routines', Object.assign({
    id: 'rtn-1', agentId: 'agent-1', name: 'Morning brief', instructions: 'Brief me', trigger: { kind: 'schedule', cron: '0 0 * * *', human: 'daily', tz: 'UTC' },
    delivery: { channel: 'chat', target: 'conv-1' }, notify: { mode: 'always' }, enabled: true, status: 'active', runs: [], createdAt: NOW, ownerId: OWNER,
  }, extra) as never);
  const timer = () => createRoutineTimerHandlers({ store, enqueuer, capabilities });

  it('never fires a routine that is waiting for setup', async () => {
    await row({ status: 'needs_setup', requires: [{ capability: 'calendar', options: ['google-calendar'] }] });
    const received: unknown[] = [];
    await timer().fire(ctx(timerState(), received), { at: NOW, routineId: 'rtn-1', generation: 0 });
    expect(received).toHaveLength(0);
  });

  it('checks the owner\'s apps when it fires: a connection lost since puts it on hold instead of running it', async () => {
    await row({ requires: [{ capability: 'calendar', options: ['google-calendar'] }] });
    const received: unknown[] = [];
    await timer().fire(ctx(timerState(), received), { at: NOW, routineId: 'rtn-1', generation: 0 });
    expect(received).toHaveLength(0);
    expect(await store.get('routines', 'rtn-1')).toMatchObject({ status: 'needs_setup' });

    await store.patch('routines', 'rtn-1', { status: 'active', missing: undefined });
    await connection('c1', 'google-calendar', 'Google Calendar');
    await timer().fire(ctx(timerState(), received), { at: NOW, routineId: 'rtn-1', generation: 0 });
    expect(received).toHaveLength(1);
  });
});

describe('mac as a capability', () => {
  it('is met only when the Mac is usable for that agent', () => {
    const have = (mac: boolean) => ({ connectors: new Map(), webSearch: false, computer: false, mac });
    expect(optionMet('mac', have(true))).toBe(true);
    expect(optionMet('mac', have(false))).toBe(false);
  });

  it('closes a chat Connect card for mac and wakes the agent in that chat once the Mac is usable', async () => {
    const request = { id: 'req-mac', kind: 'connect', status: 'pending', title: 'Connect your apps', summary: '', agentId: 'agent-1', conversationId: 'conv-1', payload: { kind: 'connect', appIds: ['mac'], label: 'Your Mac' }, createdAt: NOW, ownerId: OWNER };
    await store.put('requests', request as never);
    let usable = false;
    const run = () => inOwnerScope(OWNER, () => reconcileOwner({ store, enqueuer, capabilities, macUsable: async () => usable }, OWNER));
    await run();
    expect((await store.get('requests', 'req-mac'))?.status).toBe('pending');
    expect(wakes()).toHaveLength(0);
    usable = true;
    await run();
    expect((await store.get('requests', 'req-mac'))?.status).toBe('approved');
    expect(wakes()).toMatchObject([{ kind: 'capability_ready', agentId: 'agent-1', conversationId: 'conv-1' }]);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, PhoneDeclaration } from '@agent-desktop/public-contracts';
import type { Store } from '../../contracts/index.js';
import { createMemoryStore } from '../../testing/store.js';
import { PHONE_CLOSED, buildPhoneSection, callPhone, completePhoneCall, declarePhone, phoneDeclaration, phoneRefusal, withdrawPhone } from '../phone.js';
import { connectClient, resetPresence } from '../presence.js';

const OWNER = 'owner-1';
const phone = (actions: PhoneDeclaration['actions']): PhoneDeclaration => ({ deviceId: 'phone-1', name: "Robin's iPhone", osVersion: 'iOS 26.0', actions });

type Call = Extract<AgentEvent, { type: 'device.call' }>;

/** A real (memory) store whose `device.call` events are recorded instead of resolved against an agent. */
function recorder(): { store: Store; events: Call[] } {
  const events: Call[] = [];
  const store: Store = { ...createMemoryStore(), emit: async (event) => { if (event.type === 'device.call') events.push(event); } };
  return { events, store };
}

const call = (store: Store, callId: string, timeoutMs = 1_000) =>
  callPhone({ ownerId: OWNER, agentId: 'a1', callId, action: 'calendar.list_events', args: { from: 'a', to: 'b' }, store, timeoutMs });

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => resetPresence());

/** The iPhone app holds its stream and declares: what the coordinator does. */
async function open(store: Store, actions: PhoneDeclaration['actions']): Promise<() => Promise<void>> {
  const leave = await connectClient(store, OWNER, 'ios');
  await declarePhone(store, OWNER, phone(actions));
  return leave;
}

describe('iPhone declaration', () => {
  it('is stored while declared, replaced by a new declaration, and withdrawn on request', async () => {
    const { store } = recorder();
    await connectClient(store, OWNER, 'ios');
    expect(await phoneDeclaration(store, OWNER)).toBeUndefined();
    await declarePhone(store, OWNER, phone(['calendar.read']));
    expect((await phoneDeclaration(store, OWNER))?.actions).toEqual(['calendar.read']);
    await declarePhone(store, OWNER, phone(['calendar.read', 'reminders.read']));
    expect((await phoneDeclaration(store, OWNER))?.actions).toEqual(['calendar.read', 'reminders.read']);
    await withdrawPhone(store, OWNER, 'another-phone');
    expect(await phoneDeclaration(store, OWNER)).toBeDefined();
    await withdrawPhone(store, OWNER, 'phone-1');
    expect(await phoneDeclaration(store, OWNER)).toBeUndefined();
  });

  it('goes away with the last iPhone event stream, and with no other kind of app', async () => {
    const { store } = recorder();
    const leaveFirst = await connectClient(store, OWNER, 'ios');
    const leaveSecond = await connectClient(store, OWNER, 'ios');
    const leaveWeb = await connectClient(store, OWNER, 'web');
    await declarePhone(store, OWNER, phone(['calendar.read']));
    await leaveWeb();
    await leaveFirst();
    expect(await phoneDeclaration(store, OWNER)).toBeDefined();
    await leaveSecond();
    expect(await phoneDeclaration(store, OWNER)).toBeUndefined();
  });

  it('refuses a call the app did not declare, saying what the owner can do', async () => {
    const { store } = recorder();
    expect(await phoneRefusal(store, OWNER, 'calendar.list_events')).toBe(PHONE_CLOSED);
    await open(store, ['calendar.write']);
    expect(await phoneRefusal(store, OWNER, 'calendar.create_event')).toBeUndefined();
    expect(await phoneRefusal(store, OWNER, 'calendar.list_events')).toContain("can't read the calendar");
    // Write-only calendar access can add events but not change or delete one (that needs to read it first).
    expect(await phoneRefusal(store, OWNER, 'calendar.update_event')).toContain("can't read the calendar");
    expect(await phoneRefusal(store, OWNER, 'calendar.delete_event')).toContain("can't read the calendar");
    expect(await phoneRefusal(store, OWNER, 'reminders.create')).toContain('Reminders');
    expect(await phoneRefusal(store, OWNER, 'reminders.create')).toContain('nothing was done');
  });
});

describe('iPhone calls', () => {
  it('sends a call on the owner stream to the declared device and returns the app\'s answer', async () => {
    const { store, events } = recorder();
    await open(store, ['calendar.read']);
    const waiting = call(store, 'c1');
    await tick();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'device.call', agentId: 'a1', deviceId: 'phone-1', callId: 'c1', action: 'calendar.list_events', args: { from: 'a', to: 'b' } });
    expect(Date.parse(events[0]?.expiresAt ?? '')).toBeGreaterThan(Date.now());
    expect(await completePhoneCall(store, OWNER, 'c1', { ok: true, data: [{ id: 'e1' }] })).toBe(true);
    expect(await waiting).toEqual({ kind: 'done', result: { ok: true, data: [{ id: 'e1' }] } });
  });

  it('ignores a duplicate answer, an answer to an unknown call and another owner\'s answer', async () => {
    const { store } = recorder();
    await open(store, ['calendar.read']);
    const waiting = call(store, 'c2');
    await tick();
    expect(await completePhoneCall(store, 'owner-2', 'c2', { ok: true, data: 'stolen' })).toBe(false);
    expect(await completePhoneCall(store, OWNER, 'nope', { ok: true, data: 1 })).toBe(false);
    expect(await completePhoneCall(store, OWNER, 'c2', { ok: true, data: 'first' })).toBe(true);
    expect(await completePhoneCall(store, OWNER, 'c2', { ok: true, data: 'second' })).toBe(false);
    expect(await waiting).toEqual({ kind: 'done', result: { ok: true, data: 'first' } });
  });

  it('times out when the app never answers, and a late answer changes nothing', async () => {
    const { store, events } = recorder();
    await open(store, ['calendar.read']);
    expect(await call(store, 'c3', 60)).toEqual({ kind: 'timeout' });
    expect(await completePhoneCall(store, OWNER, 'c3', { ok: true, data: 'late' })).toBe(false);
    // Sent once, never sent again by the broker.
    expect(events).toHaveLength(1);
  });

  it('is lost when the app disconnects while the call waits, and when the run is cancelled', async () => {
    const { store } = recorder();
    const leave = await open(store, ['calendar.read']);
    const waiting = call(store, 'c4', 5_000);
    await tick();
    await leave();
    expect(await waiting).toEqual({ kind: 'lost' });

    await open(store, ['calendar.read']);
    const controller = new AbortController();
    const cancelled = callPhone({ ownerId: OWNER, agentId: 'a1', callId: 'c5', action: 'calendar.list_events', args: {}, store, signal: controller.signal, timeoutMs: 5_000 });
    controller.abort();
    expect(await cancelled).toEqual({ kind: 'lost' });
  });
});

describe('iPhone context section', () => {
  it('is empty while the app is not open, lists what is declared and what is not, and follows a change', async () => {
    const { store } = recorder();
    expect(await buildPhoneSection(store, OWNER)).toBe('');
    await open(store, ['calendar.read', 'calendar.write']);
    const text = await buildPhoneSection(store, OWNER);
    expect(text).toContain('## Your iPhone');
    expect(text).toContain('calendar.read');
    expect(text).toContain('Not allowed on the phone: reminders.read, reminders.write');
    expect(text).toContain('tool_search');
    await declarePhone(store, OWNER, phone([]));
    expect(await buildPhoneSection(store, OWNER)).toContain('declares these actions: none');
    await withdrawPhone(store, OWNER);
    expect(await buildPhoneSection(store, OWNER)).toBe('');
  });
});

/**
 * The iPhone declares over HTTP while its event stream is open and answers calls with a POST; both are owner-scoped, the
 * declaration needs an open iOS stream, and an answer nobody waits for is reported, not an error.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '@agent-desktop/db';
import { callPhone, phoneDeclaration } from 'juno-agent/execution/phone';
import { connectClient, resetPresence } from 'juno-agent/execution/presence';
import { createTestApp, requestAs } from '../../__tests__/test-app.js';

const declaration = { deviceId: 'phone-1', name: "Robin's iPhone", osVersion: 'iOS 26.0', actions: ['calendar.read', 'reminders.read'] };

function makeApp() {
  const mem = createMemoryStore();
  return { mem, app: createTestApp({ store: mem, bus: mem.eventBus, enqueuer: new NoopEnqueuer() }) };
}

afterEach(() => resetPresence());

describe('iPhone declaration and call routes', () => {
  it('declares only while the iOS stream is open, rejects a bad body, and withdraws', async () => {
    const { mem, app } = makeApp();
    const put = (owner: string, body: unknown) => requestAs(app, owner, '/v1/phone/declaration', { method: 'PUT', body });
    expect((await put('owner-a', declaration)).status).toBe(409);
    const leave = await connectClient(mem, 'owner-a', 'ios');
    expect((await put('owner-a', { ...declaration, actions: ['mail.send'] })).status).toBe(400);
    expect((await put('owner-a', { ...declaration, deviceId: 'bad id!' })).status).toBe(400);
    expect((await put('owner-a', declaration)).status).toBe(204);
    expect((await phoneDeclaration(mem, 'owner-a'))?.actions).toEqual(['calendar.read', 'reminders.read']);
    // Another owner has nothing, and cannot withdraw this one.
    expect(await phoneDeclaration(mem, 'owner-b')).toBeUndefined();
    await requestAs(app, 'owner-b', '/v1/phone/declaration', { method: 'DELETE' });
    expect(await phoneDeclaration(mem, 'owner-a')).toBeDefined();
    expect((await requestAs(app, 'owner-a', '/v1/phone/declaration?deviceId=phone-1', { method: 'DELETE' })).status).toBe(204);
    expect(await phoneDeclaration(mem, 'owner-a')).toBeUndefined();
    // The stream closing withdraws a declaration the app never took back.
    expect((await put('owner-a', declaration)).status).toBe(204);
    await leave();
    expect(await phoneDeclaration(mem, 'owner-a')).toBeUndefined();
  });

  it('delivers an answer to the waiting call once; a repeat, an unknown call or another owner is not applied', async () => {
    const { mem, app } = makeApp();
    await connectClient(mem, 'owner-a', 'ios');
    await requestAs(app, 'owner-a', '/v1/phone/declaration', { method: 'PUT', body: declaration });
    // The worker's side: the same database, its own handle (the event it emits goes nowhere here).
    const worker = { ...mem, emit: async () => undefined };
    const waiting = callPhone({ ownerId: 'owner-a', agentId: 'a1', callId: 'call-1', action: 'calendar.list_calendars', args: {}, store: worker, timeoutMs: 2_000 });
    const answer = (owner: string, callId: string, body: unknown) => requestAs(app, owner, `/v1/phone/calls/${callId}/result`, { method: 'POST', body });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await answer('owner-a', 'call-1', { ok: 'maybe' })).status).toBe(400);
    expect(await (await answer('owner-b', 'call-1', { ok: true, data: 'stolen' })).json()).toEqual({ applied: false });
    expect(await (await answer('owner-a', 'call-1', { ok: true, data: ['Work'] })).json()).toEqual({ applied: true });
    expect(await (await answer('owner-a', 'call-1', { ok: true, data: ['Again'] })).json()).toEqual({ applied: false });
    expect(await (await answer('owner-a', 'unknown', { ok: false, error: 'x' })).json()).toEqual({ applied: false });
    expect(await waiting).toEqual({ kind: 'done', result: { ok: true, data: ['Work'] } });
  });
});

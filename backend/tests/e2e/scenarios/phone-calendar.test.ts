import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptedChat, toolCall, waitForToolActivity, type Account, type EventListener } from '../harness/client';

/**
 * The iPhone's calendar and reminders through the whole stack, with a fake phone (the real app is checked on the device). The
 * phone is just an `ios` event stream plus the two routes: it declares what EventKit allowed, receives `device.call` events and
 * answers them with a POST. No silent push, no waking: when the stream is closed the tools are refused.
 *
 * Covered: answers (read, then an approved create), answers too late (the write is reported as "may or may not", sent once, the
 * late answer is not applied), never answers (a read says nothing changed), and no phone at all / a phone that went away.
 */
type Behaviour = 'answer' | 'late' | 'never';

const DECLARATION = { deviceId: 'e2e-phone', name: 'E2E iPhone', osVersion: 'iOS 26.0', actions: ['calendar.read', 'calendar.write', 'reminders.read', 'reminders.write'] };

interface FakePhone {
  stream: EventListener;
  calls: Array<{ callId: string; action: string; args: Record<string, unknown>; expiresAt: string }>;
  late: Array<{ callId: string; applied: boolean }>;
  close(): void;
}

/** Open the phone's stream, declare, and answer each call the way `behaviour` says (late = after the 20 s wait is over). */
async function openPhone(account: Account, behaviour: (action: string) => Behaviour, declaration = DECLARATION): Promise<FakePhone> {
  const stream = await listenEvents(account.cookie, 'ios');
  const declared = await account.api('PUT', '/v1/phone/declaration', declaration);
  expect(declared.status).toBe(204);
  const phone: FakePhone = { stream, calls: [], late: [], close: () => stream.close() };
  let seen = 0;
  const answer = async (callId: string, ok: boolean, data: unknown) => (await account.api('POST', `/v1/phone/calls/${callId}/result`, ok ? { ok, data } : { ok, error: String(data) })).body;
  const timer = setInterval(() => {
    for (const event of stream.events.slice(seen)) {
      seen += 1;
      if (event.data.type !== 'device.call') continue;
      const call = event.data;
      phone.calls.push({ callId: call.callId, action: call.action, args: call.args, expiresAt: call.expiresAt });
      const mode = behaviour(call.action);
      if (mode === 'never') continue;
      const data = call.action === 'calendar.list_events' ? [{ id: 'ev-1', title: 'Dentist', start: '2026-10-23T09:00:00+08:00' }] : { id: 'ev-new' };
      if (mode === 'answer') void answer(call.callId, true, data);
      else setTimeout(() => void answer(call.callId, true, data).then((body) => phone.late.push({ callId: call.callId, applied: body.applied })), 23_000);
    }
  }, 50);
  const close = phone.close;
  phone.close = () => { clearInterval(timer); close(); };
  return phone;
}

const approveNext = async (account: Account, events: EventListener, conversationId: string) => {
  const created = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.conversationId === conversationId, 40_000);
  const resolved = await account.api('POST', `/v1/requests/${created.data.request.id}/resolve`, { action: 'approve' });
  expect(resolved.status).toBe(200);
  return created.data.request;
};

describe('iPhone calendar and reminders', () => {
  it('answers a read at once and a create after the owner approves it', async () => {
    const account = await createAccount('phone-cal');
    const agent = await account.api('POST', '/v1/agents', { name: 'Planner' });
    const phone = await openPhone(account, () => 'answer');
    const events = await listenEvents(account.cookie);
    try {
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('p1', 'phone_calendar_list_events', { from: '2026-10-23T00:00', to: '2026-10-24T00:00' })] },
        { toolCalls: [toolCall('p2', 'phone_calendar_create_event', { title: 'Lunch with Mei', start: '2026-10-23T12:00', end: '2026-10-23T13:00' })] },
        { text: 'PHONE-DONE' },
      ], 'what is on tomorrow, then add lunch');
      const request = await approveNext(account, events, conversationId);
      expect(request.payload.brief?.categories).toEqual(['committing']);
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes('PHONE-DONE'), 40_000);
      const activity = await waitForToolActivity(sessionKey, (a) => a.results.length >= 2);
      expect(activity.results.map((r) => [r.toolName, r.isError])).toEqual([['phone_calendar_list_events', false], ['phone_calendar_create_event', false]]);
      expect(activity.results[0]?.text).toContain('Dentist');
      expect(phone.calls.map((c) => c.action)).toEqual(['calendar.list_events', 'calendar.create_event']);
      // Each call carries a deadline (the app drops one it receives after it).
      expect(Date.parse(phone.calls[0]?.expiresAt ?? '')).toBeGreaterThan(Date.now() - 60_000);
    } finally {
      phone.close();
      events.close();
    }
  });

  it('a write that is answered too late is reported as maybe-applied and sent once; a read nobody answers changes nothing', async () => {
    const account = await createAccount('phone-cal-late');
    const agent = await account.api('POST', '/v1/agents', { name: 'Planner' });
    const phone = await openPhone(account, (action) => (action === 'calendar.create_event' ? 'late' : 'never'));
    const events = await listenEvents(account.cookie);
    try {
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('l1', 'phone_calendar_create_event', { title: 'Late one', start: '2026-10-23T15:00', end: '2026-10-23T16:00' })] },
        { toolCalls: [toolCall('l2', 'phone_reminders_list', {})] },
        { text: 'LATE-DONE' },
      ], 'add it, then list my reminders');
      await approveNext(account, events, conversationId);
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes('LATE-DONE'), 90_000);
      const activity = await waitForToolActivity(sessionKey, (a) => a.results.length >= 2, 60_000);
      expect(activity.results[0]).toMatchObject({ toolName: 'phone_calendar_create_event', isError: true });
      expect(activity.results[0]?.text).toContain('may or may not have been applied');
      expect(activity.results[1]).toMatchObject({ toolName: 'phone_reminders_list', isError: true });
      expect(activity.results[1]?.text).toContain('Nothing changed');
      // The write went out once, and the answer that came after the wait was not applied to anything.
      expect(phone.calls.filter((c) => c.action === 'calendar.create_event')).toHaveLength(1);
      for (let attempt = 0; attempt < 100 && phone.late.length === 0; attempt += 1) await new Promise((r) => setTimeout(r, 300));
      expect(phone.late).toEqual([{ callId: phone.calls[0]?.callId, applied: false }]);
    } finally {
      phone.close();
      events.close();
    }
  });

  it('is refused with no phone, with an action the phone did not declare, and once the phone went away', async () => {
    const account = await createAccount('phone-cal-closed');
    const agent = await account.api('POST', '/v1/agents', { name: 'Planner' });
    // The server never wakes a phone: without an open stream there is nothing to declare on.
    expect((await account.api('PUT', '/v1/phone/declaration', DECLARATION)).status).toBe(409);
    const first = await scriptedChat(account, agent.body.id, [
      { toolCalls: [toolCall('r1', 'phone_calendar_list_events', { from: '2026-10-23', to: '2026-10-24' })] },
      { text: 'CLOSED-SEEN' },
    ], 'what is on tomorrow');
    const closed = await waitForToolActivity(first.sessionKey, (a) => a.results.length >= 1);
    expect(closed.results[0]).toMatchObject({ toolName: 'phone_calendar_list_events', isError: true });
    expect(closed.results[0]?.text).toContain("isn't open");

    const readOnly = await openPhone(account, () => 'answer', { ...DECLARATION, actions: ['calendar.read'] });
    const second = await scriptedChat(account, agent.body.id, [
      { toolCalls: [toolCall('r2', 'phone_reminders_list', {})] },
      { text: 'MISSING-SEEN' },
    ], 'and my reminders');
    const missing = await waitForToolActivity(second.sessionKey, (a) => a.results.length >= 1);
    expect(missing.results[0]?.isError).toBe(true);
    expect(missing.results[0]?.text).toContain('nothing was done');
    expect(readOnly.calls).toEqual([]);

    // The app goes to the background: its stream closes and the declaration goes with it.
    readOnly.close();
    await new Promise((r) => setTimeout(r, 1_000));
    const third = await scriptedChat(account, agent.body.id, [
      { toolCalls: [toolCall('r3', 'phone_calendar_list_events', { from: '2026-10-23', to: '2026-10-24' })] },
      { text: 'GONE-SEEN' },
    ], 'once more');
    const gone = await waitForToolActivity(third.sessionKey, (a) => a.results.length >= 1);
    expect(gone.results[0]?.text).toContain("isn't open");
  });
});

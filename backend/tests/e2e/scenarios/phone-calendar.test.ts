import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptedChat, toolCall, waitForToolActivity, type Account } from '../harness/client';
import { DECLARATION as FULL_DECLARATION, approveNext, openPhone as openFakePhone, type Behaviour } from '../harness/phone';

/**
 * The iPhone's calendar and reminders through the whole stack, with a fake phone (the real app is checked on the device). The
 * phone is just an `ios` event stream plus the two routes: it declares what EventKit allowed, receives `device.call` events and
 * answers them with a POST. No silent push, no waking: when the stream is closed the tools are refused.
 *
 * Covered: answers (read, then an approved create), answers too late (the write is reported as "may or may not", sent once, the
 * late answer is not applied), never answers (a read says nothing changed), and no phone at all / a phone that went away.
 */
const DECLARATION = { ...FULL_DECLARATION, actions: ['calendar.read', 'calendar.write', 'reminders.read', 'reminders.write'] };
/** Reminder writes are answered per item, like the phone does; a title starting "Bad" fails. */
const reminderAnswers = (args: Record<string, unknown>) => ({
  results: (args['reminders'] as Array<{ id?: string; title?: string }>).map((item, index) => (String(item.title).startsWith('Bad')
    ? { ok: false, error: 'No reminder with that id.' }
    : { ok: true, reminder: { id: item.id ?? `r-${String(index)}`, title: item.title } })),
});
const calendarData = (action: string, args: Record<string, unknown>) => (action === 'calendar.list_events' ? [{ id: 'ev-1', title: 'Dentist', start: '2026-10-23T09:00:00+08:00' }] : action.startsWith('reminders.') ? reminderAnswers(args) : { id: 'ev-new' });
const openPhone = (account: Account, behaviour: (action: string) => Behaviour, declaration = DECLARATION) => openFakePhone(account, behaviour, calendarData, declaration);

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

  it('several reminders are one call to the phone and one result; deleting several asks once, listing them, and one item failing is reported', async () => {
    const account = await createAccount('phone-rem-batch');
    const agent = await account.api('POST', '/v1/agents', { name: 'Planner' });
    const phone = await openPhone(account, () => 'answer');
    const events = await listenEvents(account.cookie);
    try {
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('b1', 'phone_reminders_create', { reminders: [{ title: 'Milk', due: '2026-11-03T09:00' }, { title: 'Eggs' }, { title: 'Bread' }] })] },
        { toolCalls: [toolCall('b2', 'phone_reminders_delete', { reminders: [{ id: 'x1', title: 'Old one', due: '2026-08-08T22:00:00+08:00' }, { id: 'x2', title: 'Bad one' }] })] },
        { text: 'BATCH-DONE' },
      ], 'add three reminders, then delete two');
      const request = await approveNext(account, events, conversationId);
      expect(request.payload.brief?.facts?.targets).toEqual([{ kind: 'record', label: 'Old one · 2026-08-08 22:00' }, { kind: 'record', label: 'Bad one' }]);
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes('BATCH-DONE'), 40_000);
      const activity = await waitForToolActivity(sessionKey, (a) => a.results.length >= 2);
      // One device.call per tool call, whatever the number of reminders; exactly one approval card for the delete.
      expect(phone.calls.map((c) => c.action)).toEqual(['reminders.create', 'reminders.delete']);
      expect(events.events.filter((e) => e.data.type === 'request.created' && e.data.request.conversationId === conversationId)).toHaveLength(1);
      expect(activity.results[0]?.text.split('\n')[0]).toBe('Added 3 reminders.');
      expect(activity.results[1]?.text.split('\n')[0]).toBe('Deleted 1 of 2 reminders; 1 failed.');
      expect(activity.results[1]?.text).toContain('- Failed "Bad one": No reminder with that id.');
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
    expect(closed.results[0]?.text).toContain("isn't connected");

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
    expect(gone.results[0]?.text).toContain("isn't connected");
  });
});

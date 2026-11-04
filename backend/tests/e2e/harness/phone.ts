import { expect } from 'vitest';
import { listenEvents, type Account, type EventListener } from './client';

/**
 * A fake iPhone for the e2e stack (the real app is checked on the device): an `ios` event stream plus the phone routes. It
 * declares what the owner allowed, receives `device.call` events and answers each with a POST. No silent push, no waking: when
 * the stream is closed the phone tools are refused.
 */
export type Behaviour = 'answer' | 'late' | 'never';

export const DECLARATION = {
  deviceId: 'e2e-phone', name: 'E2E iPhone', osVersion: 'iOS 26.0',
  actions: ['calendar.read', 'calendar.write', 'reminders.read', 'reminders.write', 'contacts.read', 'contacts.write'],
};

export interface FakePhone {
  stream: EventListener;
  calls: Array<{ callId: string; action: string; args: Record<string, unknown>; expiresAt: string }>;
  late: Array<{ callId: string; applied: boolean }>;
  close(): void;
}

/** What the phone says for a call it answers. */
export type PhoneData = (action: string, args: Record<string, unknown>) => unknown;

/** Open the phone's stream, declare, and answer each call the way `behaviour` says (late = after the 20 s wait is over). */
export async function openPhone(account: Account, behaviour: (action: string) => Behaviour, data: PhoneData, declaration = DECLARATION): Promise<FakePhone> {
  const stream = await listenEvents(account.cookie, 'ios');
  const declared = await account.api('PUT', '/v1/phone/declaration', declaration);
  expect(declared.status).toBe(204);
  const phone: FakePhone = { stream, calls: [], late: [], close: () => stream.close() };
  let seen = 0;
  const answer = async (callId: string, ok: boolean, body: unknown) => (await account.api('POST', `/v1/phone/calls/${callId}/result`, ok ? { ok, data: body } : { ok, error: String(body) })).body;
  const timer = setInterval(() => {
    for (const event of stream.events.slice(seen)) {
      seen += 1;
      if (event.data.type !== 'device.call') continue;
      const call = event.data;
      phone.calls.push({ callId: call.callId, action: call.action, args: call.args, expiresAt: call.expiresAt });
      const mode = behaviour(call.action);
      if (mode === 'never') continue;
      const body = data(call.action, call.args);
      // Data that is an Error is the phone saying it could not do the call.
      if (mode === 'answer') void (body instanceof Error ? answer(call.callId, false, body.message) : answer(call.callId, true, body));
      else setTimeout(() => void answer(call.callId, true, body).then((result) => phone.late.push({ callId: call.callId, applied: result.applied })), 23_000);
    }
  }, 50);
  const close = phone.close;
  phone.close = () => { clearInterval(timer); close(); };
  return phone;
}

/** Wait for the next approval card of a conversation and approve it. */
export const approveNext = async (account: Account, events: EventListener, conversationId: string) => {
  const created = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.conversationId === conversationId, 40_000);
  const resolved = await account.api('POST', `/v1/requests/${created.data.request.id}/resolve`, { action: 'approve' });
  expect(resolved.status).toBe(200);
  return created.data.request;
};

import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agent-desktop/public-contracts';
import type { Store, Tool, ToolContext } from '../../../contracts/index.js';
import { PHONE_CLOSED, completePhoneCall, declarePhone, withdrawPhone } from '../../../execution/phone.js';
import { connectClient, resetPresence } from '../../../execution/presence.js';
import { createMemoryStore } from '../../../testing/store.js';
import { PHONE_TOOLS, PHONE_WRITE_TOOLS, createPhoneTools } from '../tools/phoneTools.js';

const OWNER = 'owner-1';

afterEach(() => resetPresence());

const tools = createPhoneTools();
const tool = (name: string): Tool => {
  const found = tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error('missing tool ' + name);
  return found;
};

type Call = Extract<AgentEvent, { type: 'device.call' }>;

/** A run context whose store hands each call to `phone`, the way the app would answer over the stream. */
function context(phone: (call: Call, store: Store) => Promise<unknown>): { ctx: ToolContext; store: Store; calls: Call[]; steps: string[] } {
  const calls: Call[] = [];
  const steps: string[] = [];
  const store: Store = {
    ...createMemoryStore(),
    emit: async (event: AgentEvent) => { if (event.type === 'device.call') { calls.push(event); await phone(event, store); } },
  };
  const ctx = {
    ownerId: OWNER, agentId: 'a1', conversationId: 'c1', runId: 'run1', stepId: 's1', signal: new AbortController().signal,
    store,
    step: async <T>(name: string, fn: () => Promise<T>): Promise<T> => { steps.push(name); return fn(); },
  } as unknown as ToolContext;
  return { ctx, store, calls, steps };
}

/** The iPhone app holds its stream and declares: what the coordinator does. */
async function declare(store: Store, actions: Parameters<typeof declarePhone>[2]['actions']): Promise<void> {
  await connectClient(store, OWNER, 'ios');
  await declarePhone(store, OWNER, { deviceId: 'phone-1', name: 'Phone', osVersion: 'iOS 26', actions });
}
const text = (result: { content: Array<{ type: string; text?: string }> }): string => result.content.map((part) => part.text ?? '').join('');

describe('iPhone calendar and reminders tools', () => {
  it('knows which tools change things', () => {
    expect([...PHONE_TOOLS].sort()).toEqual(tools.map((t) => t.name).sort());
    for (const t of tools) {
      expect(t.sideEffect, t.name).toBe(PHONE_WRITE_TOOLS.has(t.name));
      expect(t.replay, t.name).toBe(PHONE_WRITE_TOOLS.has(t.name) ? 'never' : 'safe');
    }
  });

  it('refuses while the app is not open or did not declare the action, without sending anything', async () => {
    const { ctx, store, calls, steps } = context(async () => undefined);
    const closed = await tool('phone_calendar_list_events').execute({ from: '2026-10-22', to: '2026-10-23' }, ctx);
    expect(closed).toMatchObject({ isError: true });
    expect(text(closed)).toBe(PHONE_CLOSED);
    await declare(store, ['reminders.read']);
    const missing = await tool('phone_calendar_create_event').execute({ title: 'x', start: '2026-10-22T10:00', end: '2026-10-22T11:00' }, ctx);
    expect(missing).toMatchObject({ isError: true });
    expect(text(missing)).toContain('nothing was done');
    expect(calls).toEqual([]);
    expect(steps).toEqual([]);
  });

  it('sends the validated arguments and returns the phone\'s answer', async () => {
    const { ctx, store, calls, steps } = context((call, s) => completePhoneCall(s, OWNER, call.callId, { ok: true, data: [{ id: 'e1', title: 'Dentist' }] }));
    await declare(store, ['calendar.read']);
    const result = await tool('phone_calendar_list_events').execute({ from: '2026-10-22', to: '2026-10-23', limit: 5 }, ctx);
    expect(text(result)).toContain('Dentist');
    expect(result.isError).toBeUndefined();
    expect(steps).toEqual(['phone_calendar_list_events']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ action: 'calendar.list_events', args: { from: '2026-10-22', to: '2026-10-23', limit: 5 }, deviceId: 'phone-1', callId: 'phone_run1_s1' });
    const bad = await tool('phone_calendar_list_events').execute({ from: '2026-10-22' }, ctx);
    expect(bad).toMatchObject({ isError: true });
    expect(calls).toHaveLength(1);
  });

  it('passes the phone\'s own error to the agent', async () => {
    const { ctx, store } = context((call, s) => completePhoneCall(s, OWNER, call.callId, { ok: false, error: 'No reminder with that id.' }));
    await declare(store, ['reminders.write']);
    const result = await tool('phone_reminders_update').execute({ id: 'nope', completed: true }, ctx);
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toBe('No reminder with that id.');
  });

  it('tells the agent a write that got no answer may or may not have been applied, and sends it once', async () => {
    const { ctx, store, calls } = context((call, s) => withdrawPhone(s, OWNER, call.deviceId));
    await declare(store, ['calendar.read', 'calendar.write']);
    const write = await tool('phone_calendar_create_event').execute({ title: 'x', start: '2026-10-22T10:00', end: '2026-10-22T11:00' }, ctx);
    expect(write).toMatchObject({ isError: true });
    expect(text(write)).toContain('may or may not have been applied');
    expect(text(write)).toContain('read');
    expect(calls).toHaveLength(1);
    await declare(store, ['calendar.read']);
    const read = await tool('phone_calendar_list_events').execute({ from: '2026-10-22', to: '2026-10-23' }, ctx);
    expect(text(read)).toContain('Nothing changed');
  });
});

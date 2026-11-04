import { afterEach, describe, expect, it } from 'vitest';
import { PHONE_CALL_NEEDS, type AgentEvent } from '@agent-desktop/public-contracts';
import { saveBlob, type Store, type Tool, type ToolContext } from '../../../contracts/index.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { PHONE_ACTION_INFO, PHONE_CLOSED, completePhoneCall, declarePhone, withdrawPhone } from '../../../execution/phone.js';
import { connectClient, resetPresence } from '../../../execution/presence.js';
import { createMemoryStore } from '../../../testing/store.js';
import { PHONE_TOOLS, PHONE_WRITE_TOOLS, createPhoneTools, phoneToolCall } from '../tools/phoneTools.js';
import { PHONE_ACCESS_CASES, PHONE_CALENDAR_TOOLS } from './phone-cases.js';

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
    // Changes that run without asking (the owner's music and reminders) are still changes: never replayed.
    const unasked = new Set(['phone_music_play', 'phone_music_control', 'phone_reminders_create', 'phone_reminders_update']);
    for (const t of tools) {
      const changes = PHONE_WRITE_TOOLS.has(t.name) || unasked.has(t.name);
      expect(t.sideEffect, t.name).toBe(changes);
      expect(t.replay, t.name).toBe(changes ? 'never' : 'safe');
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
    const result = await tool('phone_reminders_update').execute({ reminders: [{ id: 'nope', completed: true }] }, ctx);
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

describe('iPhone access: every other phone tool is gated by what the app declared', () => {
  it('lists every phone tool, and none twice', () => {
    const covered = [...PHONE_CALENDAR_TOOLS, ...PHONE_ACCESS_CASES.map((c) => c.tool)];
    expect([...covered].sort()).toEqual([...PHONE_TOOLS].sort());
    for (const c of PHONE_ACCESS_CASES) expect(PHONE_WRITE_TOOLS.has(c.tool), c.tool).toBe(c.decision !== undefined);
  });

  for (const { tool: name, args } of PHONE_ACCESS_CASES) {
    it(`${name}: refused with no phone and with each needed action missing (nothing sent); sent when all are declared`, async () => {
      const def = tool(name);
      const call = phoneToolCall(name);
      if (call === undefined) throw new Error('not a phone tool ' + name);
      const { ctx, store, calls, steps } = context((sent, s) => completePhoneCall(s, OWNER, sent.callId, { ok: true, data: [] }));
      expect(text(await def.execute(args, ctx))).toBe(PHONE_CLOSED);
      const needs = PHONE_CALL_NEEDS[call];
      for (const missing of needs) {
        await declare(store, needs.filter((action) => action !== missing));
        const refused = await def.execute(args, ctx);
        expect(refused, `${name} without ${missing}`).toMatchObject({ isError: true });
        expect(text(refused)).toContain(PHONE_ACTION_INFO[missing].row);
        expect(text(refused)).toContain('Settings > iPhone access');
        expect(text(refused)).toContain('nothing was done');
      }
      expect(calls).toEqual([]);
      expect(steps).toEqual([]);
      await declare(store, [...needs]);
      await def.execute(args, ctx);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ action: call, args });
    });
  }

  it('rejects arguments the tool does not take, and a contact with nothing to add, before anything is sent', async () => {
    const { ctx, store, calls } = context(async () => undefined);
    await declare(store, ['contacts.read', 'contacts.write']);
    expect(await tool('phone_contacts_search').execute({ query: 'Mei', extra: 1 }, ctx)).toMatchObject({ isError: true });
    expect(await tool('phone_contacts_create').execute({ phones: ['+65 8123 4567'] }, ctx)).toMatchObject({ isError: true });
    expect(await tool('phone_contacts_add_detail').execute({ id: 'c1' }, ctx)).toMatchObject({ isError: true });
    expect(calls).toEqual([]);
  });

  it('a sent photo becomes a file in the chat and a picture for the agent; an answer that is not an uploaded picture adds nothing', async () => {
    let answer: unknown = { attachment: { id: 'lib1', name: 'IMG_1.jpg', mimeType: 'image/jpeg' }, takenAt: '2026-10-02' };
    const { ctx, store } = context((call, s) => completePhoneCall(s, OWNER, call.callId, { ok: true, data: answer }));
    const blobs = createMemoryBlobStore();
    const bytes = Buffer.from('jpeg-bytes');
    const saved = await saveBlob(blobs, bytes, 'image/jpeg');
    const now = '2026-10-02T10:00:00.000Z';
    const owned = store.forOwner?.(OWNER) ?? store;
    await owned.put('library', { id: 'lib1', name: 'IMG_1.jpg', kind: 'file', mimeType: 'image/jpeg', sizeBytes: bytes.length, shared: 'private', source: 'upload', tags: [], createdAt: now, updatedAt: now, pinned: false, blobKey: saved.blobKey, sha256: saved.sha256 });
    await declare(store, ['photos.read']);
    const send = tool('phone_photos_send');
    const sent = await send.execute({ id: 'ABC/L0/001' }, { ...ctx, blobs });
    expect(text(sent)).toContain('now in this chat');
    expect(sent.isError).toBeUndefined();
    expect(sent.content.map((part) => part.type)).toEqual(['text', 'image']);
    expect((await owned.list('items')).items).toEqual([expect.objectContaining({ conversationId: 'c1', type: 'artifact', artifactId: 'lib1' })]);
    // The upload is not in the library (or the phone said something else): nothing reaches the chat.
    answer = { attachment: { id: 'nope', name: 'x.jpg' } };
    expect(await send.execute({ id: 'ABC/L0/002' }, { ...ctx, blobs, stepId: 's2' })).toMatchObject({ isError: true });
    answer = 'done';
    expect(await send.execute({ id: 'ABC/L0/003' }, { ...ctx, blobs, stepId: 's3' })).toMatchObject({ isError: true });
    expect((await owned.list('items')).items).toHaveLength(1);
  });

  it('a home value must fit its property: power is true or false, the others are numbers', async () => {
    const { ctx, store, calls } = context(async () => undefined);
    await declare(store, ['home.read', 'home.write']);
    const set = tool('phone_home_set');
    expect(await set.execute({ accessory: 'Desk lamp', property: 'power', value: 1 }, ctx)).toMatchObject({ isError: true });
    expect(await set.execute({ accessory: 'Desk lamp', property: 'brightness', value: true }, ctx)).toMatchObject({ isError: true });
    expect(await set.execute({ accessory: 'Front door', property: 'locked', value: false }, ctx)).toMatchObject({ isError: true });
    expect(calls).toEqual([]);
  });

  it('health has no write tool, and only the metrics the phone can total', async () => {
    expect([...PHONE_TOOLS].filter((name) => name.startsWith('phone_health_'))).toEqual(['phone_health_read']);
    const { ctx, store, calls } = context(async () => undefined);
    await declare(store, ['health.read']);
    expect(await tool('phone_health_read').execute({ metric: 'heart_rate', from: '2026-10-01', to: '2026-10-07' }, ctx)).toMatchObject({ isError: true });
    expect(calls).toEqual([]);
  });

  it('a reminder at a place needs the place and its direction, and both coordinates or neither; it needs only the reminders switch', async () => {
    const { ctx, store, calls } = context((call, s) => completePhoneCall(s, OWNER, call.callId, { ok: true, data: { results: [{ ok: true, reminder: { id: 'r1', title: 'x' } }] } }));
    await declare(store, ['reminders.write']);
    const create = tool('phone_reminders_create');
    expect(await create.execute({ reminders: [{ title: 'x', place: { name: 'Office' } }] }, ctx)).toMatchObject({ isError: true });
    expect(await create.execute({ reminders: [{ title: 'x', place: { name: 'Office', when: 'arriving', latitude: 1.3 } }] }, ctx)).toMatchObject({ isError: true });
    expect(calls).toEqual([]);
    const sent = await create.execute({ reminders: [{ title: 'x', place: { name: '1 Raffles Place, Singapore', when: 'leaving', radiusMeters: 200 } }] }, ctx);
    expect(sent.isError).toBeUndefined();
    expect(calls[0]).toMatchObject({ action: 'reminders.create', args: { reminders: [{ place: { name: '1 Raffles Place, Singapore', when: 'leaving', radiusMeters: 200 } }] } });
  });

  it('several reminders are one call to the phone and one answer; a failed item is reported by name, and nothing done is an error', async () => {
    const answers: unknown[] = [
      { results: [{ ok: true, reminder: { id: 'a', title: 'Milk', due: '2026-11-03T09:00:00+08:00' } }, { ok: false, error: 'No Reminders list named "Work".' }, { ok: true, reminder: { id: 'c', title: 'Eggs' } }] },
      { results: [{ ok: false, error: 'No reminder with that id.' }] },
    ];
    const { ctx, store, calls, steps } = context((call, s) => completePhoneCall(s, OWNER, call.callId, { ok: true, data: answers.shift() }));
    await declare(store, ['reminders.write']);
    const create = tool('phone_reminders_create');
    const partial = await create.execute({ reminders: [{ title: 'Milk', due: '2026-11-03T09:00' }, { title: 'Report', list: 'Work' }, { title: 'Eggs' }] }, ctx);
    expect(calls).toHaveLength(1);
    expect(steps).toEqual(['phone_reminders_create']);
    expect(partial.isError).toBeUndefined();
    expect(text(partial).split('\n')[0]).toBe('Added 2 of 3 reminders; 1 failed.');
    expect(text(partial)).toContain('- Failed "Report": No Reminders list named "Work".');
    expect(text(partial)).toContain('"Milk" (id a, due 2026-11-03T09:00:00+08:00)');
    const none = await tool('phone_reminders_delete').execute({ reminders: [{ id: 'zz', title: 'Gone' }] }, ctx);
    expect(none).toMatchObject({ isError: true });
    expect(text(none)).toContain('Deleted none of the 1 reminder');
  });

  it('a batch holds 1 to 20 reminders, and the old single-reminder shape is refused', async () => {
    const { ctx, store, calls } = context(async () => undefined);
    await declare(store, ['reminders.write']);
    const create = tool('phone_reminders_create');
    expect(await create.execute({ reminders: [] }, ctx)).toMatchObject({ isError: true });
    expect(await create.execute({ reminders: Array.from({ length: 21 }, (_, i) => ({ title: `t${String(i)}` })) }, ctx)).toMatchObject({ isError: true });
    expect(await create.execute({ title: 'x' }, ctx)).toMatchObject({ isError: true });
    expect(await tool('phone_reminders_delete').execute({ reminders: [{ id: 'r1' }] }, ctx)).toMatchObject({ isError: true });
    expect(calls).toEqual([]);
  });
});

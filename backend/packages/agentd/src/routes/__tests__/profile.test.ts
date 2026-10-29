/** The account profile (BACKEND 8.7): owner-scoped, validated, replaced as a whole. */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { Enqueuer } from '@agent-desktop/contracts';
import { createTestApp, requestAs, withDefaultOwner } from '../../__tests__/test-app.js';

const enqueuer: Enqueuer = { enqueue: async () => ({ accepted: true }), stopRun: async () => undefined, scheduleRoutine: async () => undefined, resolveAwakeable: async () => undefined };

describe('profile', () => {
  it('starts empty, replaces the whole list, stamps sources, and keeps each owner apart', async () => {
    const mem = createMemoryStore();
    const store = withDefaultOwner(mem, 'owner-a');
    const app = createTestApp({ store, bus: mem.eventBus, enqueuer });
    const put = (owner: string, body: unknown) => requestAs(app, owner, '/v1/profile', { method: 'PUT', body });
    expect(await (await requestAs(app, 'owner-a', '/v1/profile')).json()).toEqual({ entries: [] });
    const saved = await (await put('owner-a', { entries: [{ id: 'e1', key: 'Name', value: 'Jane Tan' }, { id: 'e2', key: 'Home address', value: '10 Anson Rd\n#12-01\nSingapore 079903', visibility: 'shared' }] })).json() as { entries: unknown[] };
    expect(saved.entries).toMatchObject([{ id: 'e1', key: 'Name', visibility: 'private', source: { by: 'user' } }, { id: 'e2', visibility: 'shared' }]);
    expect(await (await requestAs(app, 'owner-a', '/v1/profile')).json()).toEqual(saved);
    expect(await (await requestAs(app, 'owner-b', '/v1/profile')).json()).toEqual({ entries: [] });
    // An agent-written entry keeps its source until the user changes it.
    await store.put('profiles', { id: 'profile-owner-a', entries: [{ id: 'e1', key: 'Name', value: 'Jane', visibility: 'private', source: { by: 'agent', agentId: 'a1', at: '2026-10-18T00:00:00.000Z' } }], updatedAt: '2026-10-18T00:00:00.000Z' } as never);
    const same = await (await put('owner-a', { entries: [{ id: 'e1', key: 'Name', value: 'Jane', visibility: 'shared' }] })).json() as { entries: Array<{ source: unknown }> };
    expect(same.entries[0]?.source).toMatchObject({ by: 'agent', agentId: 'a1' });
    const edited = await (await put('owner-a', { entries: [{ id: 'e1', key: 'Name', value: 'Jane Tan' }] })).json() as { entries: Array<{ source: unknown }> };
    expect(edited.entries[0]?.source).toMatchObject({ by: 'user' });
    await put('owner-a', { entries: [] });
    expect(await (await requestAs(app, 'owner-a', '/v1/profile')).json()).toMatchObject({ entries: [] });
  });

  it('refuses an empty key, an over-long value, unknown fields, a secret, or a list over the safety bound', async () => {
    const mem = createMemoryStore();
    const app = createTestApp({ store: withDefaultOwner(mem, 'owner-a'), bus: mem.eventBus, enqueuer });
    const put = (entries: unknown[], extra: Record<string, unknown> = {}) => requestAs(app, 'owner-a', '/v1/profile', { method: 'PUT', body: { entries, ...extra } });
    const entry = (i: number, over: Record<string, unknown> = {}) => ({ id: `e${i}`, key: `Key ${i}`, value: 'v', ...over });
    expect((await put([entry(1, { key: ' ' })])).status).toBe(400);
    expect((await put([entry(1, { key: 'x'.repeat(61) })])).status).toBe(400);
    expect((await put([entry(1, { value: 'x'.repeat(2001) })])).status).toBe(400);
    expect((await put([entry(1, { value: 'x'.repeat(2000) })])).status).toBe(200);
    expect((await put([entry(1, { visibility: 'secret' })])).status).toBe(400);
    expect((await put([entry(1, { cardNumber: '4242424242424242' })])).status).toBe(400);
    expect((await put([], { fullName: 'x' })).status).toBe(400);
    expect((await put([entry(1, { key: 'Password', value: 'hunter2' })])).status).toBe(400);
    expect((await put([entry(1, { key: 'Visa', value: '4242 4242 4242 4242' })])).status).toBe(400);
    expect((await put(Array.from({ length: 201 }, (_, i) => entry(i)))).status).toBe(400);
    expect((await put(Array.from({ length: 200 }, (_, i) => entry(i)))).status).toBe(200);
  });
});

/** The vault labels (BACKEND 8.7): owner-scoped, free labels only, never values, never CVC / one-time codes. */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { Enqueuer } from '@agent-desktop/contracts';
import { createTestApp, requestAs, withDefaultOwner } from '../../__tests__/test-app.js';

const enqueuer: Enqueuer = { enqueue: async () => ({ accepted: true }), stopRun: async () => undefined, scheduleRoutine: async () => undefined, resolveAwakeable: async () => undefined };

describe('secure vault entries', () => {
  it('stores free labels per owner, including website passwords', async () => {
    const mem = createMemoryStore();
    const app = createTestApp({ store: withDefaultOwner(mem, 'owner-a'), bus: mem.eventBus, enqueuer });
    const put = (owner: string, entries: unknown) => requestAs(app, owner, '/v1/secure-vault/keys', { method: 'PUT', body: { entries } });
    const entries = [
      { id: 'v1', label: 'Visa ending 4242', kind: 'card' },
      { id: 'v2', label: 'Shopee password', kind: 'password' },
      { id: 'v1', label: 'Visa ending 4242 (work)', kind: 'card' },
    ];
    expect(await (await put('owner-a', entries)).json()).toEqual({ entries: [entries[2], entries[1]] });
    expect(await (await requestAs(app, 'owner-a', '/v1/secure-vault/keys')).json()).toEqual({ entries: [entries[2], entries[1]] });
    expect(await (await requestAs(app, 'owner-b', '/v1/secure-vault/keys')).json()).toEqual({ entries: [] });
  });

  it('refuses CVC / one-time-code entries, a value-shaped body, a bad kind or too many entries', async () => {
    const mem = createMemoryStore();
    const app = createTestApp({ store: withDefaultOwner(mem, 'owner-a'), bus: mem.eventBus, enqueuer });
    const put = (body: unknown) => requestAs(app, 'owner-a', '/v1/secure-vault/keys', { method: 'PUT', body });
    const entry = (label: string, kind = 'other') => ({ id: 'v1', label, kind });
    expect((await put({ entries: [entry('Visa CVC', 'code')] })).status).toBe(400);
    expect((await put({ entries: [entry('SMS one-time code', 'code')] })).status).toBe(400);
    expect((await put({ entries: [entry('Bank OTP')] })).status).toBe(400);
    expect((await put({ entries: [entry('Gym locker', 'pin')] })).status).toBe(400);
    expect((await put({ entries: [{ ...entry('Card'), value: '4242' }] })).status).toBe(400);
    expect((await put({ entries: Array.from({ length: 65 }, (_, i) => ({ id: `v${i}`, label: `L${i}`, kind: 'other' })) })).status).toBe(400);
  });
});

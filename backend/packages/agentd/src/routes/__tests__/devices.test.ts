/**
 * Device registration is owner-scoped: each owner sees and removes only its own rows, the same token under
 * two owners gives two rows (no collision), re-registering upserts, and bad input is rejected before storage.
 * Runs on the production app assembly, so the request owner comes from x-owner-id as in production.
 */
import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createMemoryStore, NoopEnqueuer } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import { createTestApp, requestAs } from '../../__tests__/test-app.js';

const DEVICE = 'ab'.repeat(32);
const FCM_TOKEN = 'dKx3_Mixed-Case:APA91b' + 'Zz9'.repeat(40);

/** The production assembly with production's service identity (bearer token + x-owner-id). */
async function makeApp(): Promise<{ app: Hono; store: Store }> {
  const mem = createMemoryStore();
  const app = createTestApp({ store: mem, bus: mem.eventBus, enqueuer: new NoopEnqueuer() });
  return { app, store: mem };
}

function send(app: Hono, method: string, path: string, owner: string, body?: unknown): Promise<Response> {
  return requestAs(app, owner, path, { method, ...(body === undefined ? {} : { body }) });
}

function registration(token = DEVICE, environment = 'sandbox') {
  return { platform: 'ios', token, environment, bundleId: 'io.github.nigelleong0703.juno' };
}

async function tokensOf(store: Store, owner: string): Promise<string[]> {
  const page = await store.forOwner!(owner).list('devices');
  return page.items.map((row) => row.token);
}

describe('device registration', () => {
  it('registers under the caller owner and upserts the same token', async () => {
    const { app, store } = await makeApp();
    expect((await send(app, 'POST', '/v1/devices', 'owner-a', registration())).status).toBe(200);
    expect((await send(app, 'POST', '/v1/devices', 'owner-a', registration(DEVICE, 'production'))).status).toBe(200);
    const page = await store.forOwner!('owner-a').list('devices');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ token: DEVICE, environment: 'production' });
    expect(await tokensOf(store, 'owner-b')).toEqual([]);
  });

  it('keeps the same token separate per owner and only unregisters the caller own row', async () => {
    const { app, store } = await makeApp();
    await send(app, 'POST', '/v1/devices', 'owner-a', registration());
    await send(app, 'POST', '/v1/devices', 'owner-b', registration());
    expect(await tokensOf(store, 'owner-a')).toEqual([DEVICE]);
    expect(await tokensOf(store, 'owner-b')).toEqual([DEVICE]);

    expect((await send(app, 'DELETE', '/v1/devices/' + DEVICE, 'owner-b')).status).toBe(204);
    expect(await tokensOf(store, 'owner-a')).toEqual([DEVICE]);
    expect(await tokensOf(store, 'owner-b')).toEqual([]);

    expect((await send(app, 'DELETE', '/v1/devices/' + DEVICE, 'owner-b')).status).toBe(204);
  });

  it('registers Android FCM tokens as-is (case kept), upserts them, and unregisters by token', async () => {
    const { app, store } = await makeApp();
    const android = { platform: 'android', token: FCM_TOKEN, bundleId: 'io.github.nigelleong0703.juno' };
    const res = await send(app, 'POST', '/v1/devices', 'owner-a', android);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ platform: 'android', token: FCM_TOKEN, environment: 'production', bundleId: 'io.github.nigelleong0703.juno' });
    expect((await send(app, 'POST', '/v1/devices', 'owner-a', android)).status).toBe(200);
    // The lowercased token is a different token, not the same row.
    expect((await send(app, 'POST', '/v1/devices', 'owner-a', { ...android, token: FCM_TOKEN.toLowerCase() })).status).toBe(200);
    expect(await tokensOf(store, 'owner-a')).toEqual([FCM_TOKEN, FCM_TOKEN.toLowerCase()]);
    expect(await tokensOf(store, 'owner-b')).toEqual([]);

    expect((await send(app, 'DELETE', '/v1/devices/' + encodeURIComponent(FCM_TOKEN), 'owner-b')).status).toBe(204);
    expect(await tokensOf(store, 'owner-a')).toEqual([FCM_TOKEN, FCM_TOKEN.toLowerCase()]);
    expect((await send(app, 'DELETE', '/v1/devices/' + encodeURIComponent(FCM_TOKEN), 'owner-a')).status).toBe(204);
    expect(await tokensOf(store, 'owner-a')).toEqual([FCM_TOKEN.toLowerCase()]);
  });

  it('validates each platform token shape on its own', async () => {
    const { app, store } = await makeApp();
    const post = (body: unknown) => send(app, 'POST', '/v1/devices', 'owner-a', body).then((r) => r.status);
    const android = { platform: 'android', bundleId: 'io.github.nigelleong0703.juno' };
    // An FCM-shaped token is not hex, so it is no APNs token; an Android token has its own charset and length bounds.
    expect(await post(registration(FCM_TOKEN))).toBe(400);
    expect(await post({ ...android, token: 'bad token!' + 'a'.repeat(100) })).toBe(400);
    expect(await post({ ...android, token: 'a'.repeat(63) })).toBe(400);
    expect(await post({ ...android, token: 'a'.repeat(513) })).toBe(400);
    expect(await post({ platform: 'windows', token: FCM_TOKEN, bundleId: 'x' })).toBe(400);
    expect(await post(android)).toBe(400);
    expect((await send(app, 'DELETE', '/v1/devices/bad%20token', 'owner-a')).status).toBe(400);
    expect(await tokensOf(store, 'owner-a')).toEqual([]);
  });

  it('rejects malformed tokens and environments before storage', async () => {
    const { app, store } = await makeApp();
    expect((await send(app, 'POST', '/v1/devices', 'owner-a', registration('not-hex!'))).status).toBe(400);
    expect((await send(app, 'POST', '/v1/devices', 'owner-a', registration(DEVICE, 'staging'))).status).toBe(400);
    expect((await send(app, 'DELETE', '/v1/devices/..%2Fsecrets', 'owner-a')).status).toBe(400);
    expect(await tokensOf(store, 'owner-a')).toEqual([]);
  });
});

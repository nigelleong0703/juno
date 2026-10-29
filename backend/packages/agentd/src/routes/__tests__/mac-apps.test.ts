/**
 * "<Agent> wants to use <App> on your Mac" (BACKEND §7.12): Allow once leaves nothing behind, Always allow keeps the app per owner
 * (listed and taken back through /v1/mac/apps), Don't allow refuses, and the foreground ask can never be kept.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '@agent-desktop/db';
import type { Store, StoredRequest } from '@agent-desktop/contracts';
import { createTestApp, requestAs } from '../../__tests__/test-app.js';

const A = 'owner-a';
const B = 'owner-b';

function useRequest(id: string, purpose: 'use' | 'foreground', app = 'notes', name = 'Notes'): StoredRequest {
  return {
    id, kind: 'approval', status: 'pending', title: `Use ${name} on your Mac`, summary: 'The agent wants to use an app on your Mac', agentId: 'agent-a', createdAt: new Date().toISOString(),
    payload: { kind: 'approval', action: 'use', why: 'asked', macApp: { app, name, purpose } },
  };
}

async function build() {
  const mem = createMemoryStore();
  const app = createTestApp({ store: mem, bus: mem.eventBus, enqueuer: new NoopEnqueuer() });
  const own = mem.forOwner?.(A) as Store;
  await own.put('agents', { id: 'agent-a', name: 'Atlas' } as never);
  for (const [id, purpose] of [['req-once', 'use'], ['req-always', 'use'], ['req-deny', 'use'], ['req-front', 'foreground']] as const) await own.put('requests', useRequest(id, purpose));
  await own.put('requests', { ...useRequest('req-mail', 'use', 'com.apple.mail', 'Mail') });
  return { app };
}

const resolve = (app: ReturnType<typeof createTestApp>, owner: string, id: string, body: unknown) => requestAs(app, owner, `/v1/requests/${id}/resolve`, { method: 'POST', body });
const apps = async (app: ReturnType<typeof createTestApp>, owner: string) => ((await (await requestAs(app, owner, '/v1/mac/apps')).json()) as { apps: Array<{ app: string; name: string }> }).apps;

describe('apps allowed on the Mac', () => {
  it('Allow once keeps nothing, Always allow keeps the app, Don\'t allow keeps nothing', async () => {
    const { app } = await build();
    expect((await resolve(app, A, 'req-once', { action: 'approve' })).status).toBe(200);
    expect(await apps(app, A)).toEqual([]);
    expect((await resolve(app, A, 'req-deny', { action: 'deny' })).status).toBe(200);
    expect(await apps(app, A)).toEqual([]);

    const always = await resolve(app, A, 'req-always', { action: 'approve', scope: 'app' });
    expect(always.status).toBe(200);
    expect(await always.json()).toMatchObject({ status: 'approved', decision: { scope: 'app' } });
    expect(await apps(app, A)).toEqual([expect.objectContaining({ app: 'notes', name: 'Notes' })]);
  });

  it('is per owner, and the owner takes an app back (the next use asks again)', async () => {
    const { app } = await build();
    await resolve(app, A, 'req-always', { action: 'approve', scope: 'app' });
    await resolve(app, A, 'req-mail', { action: 'approve', scope: 'app' });
    expect((await apps(app, A)).map((entry) => entry.app).sort()).toEqual(['com.apple.mail', 'notes']);
    expect(await apps(app, B)).toEqual([]);

    expect((await requestAs(app, B, '/v1/mac/apps/notes', { method: 'DELETE' })).status).toBe(404);
    const removed = await requestAs(app, A, '/v1/mac/apps/notes', { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { apps: Array<{ app: string }> }).apps.map((entry) => entry.app)).toEqual(['com.apple.mail']);
    expect((await requestAs(app, A, '/v1/mac/apps/notes', { method: 'DELETE' })).status).toBe(404);
    expect((await requestAs(app, A, `/v1/mac/apps/${encodeURIComponent('com.apple.mail')}`, { method: 'DELETE' })).status).toBe(200);
    expect(await apps(app, A)).toEqual([]);
  });

  it('never keeps the foreground ask, a denial, or an app on a request that is not about an app', async () => {
    const { app } = await build();
    expect((await resolve(app, A, 'req-front', { action: 'approve', scope: 'app' })).status).toBe(400);
    expect((await resolve(app, A, 'req-deny', { action: 'deny', scope: 'app' })).status).toBe(400);
    expect(await apps(app, A)).toEqual([]);
    // The foreground ask is still an ordinary one-tap yes.
    expect((await resolve(app, A, 'req-front', { action: 'approve' })).status).toBe(200);
    expect(await apps(app, A)).toEqual([]);
  });
});

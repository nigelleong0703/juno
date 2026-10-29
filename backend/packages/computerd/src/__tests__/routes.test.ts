/**
 * computerd route behaviour with the fake provider: the security and lifecycle rules the API
 * promises — bearer required, an unknown agent is refused (never allocated for a caller that is not
 * a real agent), and a taken-over screen refuses agent actions.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { createFakeProvider, createScreenPool, MAX_LIVE_SCREENS } from '@agent-desktop/sandbox-adapters';
import type { Agent } from '@agent-desktop/public-contracts';
import { createComputerApp } from '../transport/routes.js';
import { createLifecycle } from '../modules/computers/lifecycle.js';
import { createComputerStateStore } from '../infrastructure/computer-state.js';

const TOKEN = 'test-token';

function agent(id: string): Agent {
  return {
    id,
    name: id,
    handle: id,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'tester',
    status: 'idle',
    section: 'Work',
    pinned: false,
    lastActivity: '',
    unreadCount: 0,
    model: {
      planner: { provider: 'scripted', model: 'test' },
      computer: { provider: 'scripted', model: 'test' },
      fast: { provider: 'scripted', model: 'test' },
    },
    channels: [],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function build() {
  const store = createMemoryStore();
  await store.put('agents', agent('agent-a'));
  const provider = createFakeProvider();
  const pool = createScreenPool(MAX_LIVE_SCREENS);
  const state = createComputerStateStore('', { sandboxId: 'sbx-test', template: 'desktop-debian' });
  const lifecycle = createLifecycle({
    store,
    provider,
    pool,
    state,
    ownerId: 'owner-1',
    host: { template: 'desktop-debian', resolution: '1280x800', timeoutMs: 1000, ramGb: 2, vcpu: 2, idlePauseMinutes: 30 },
    secret: TOKEN,
  });
  const app = createComputerApp({ lifecycle, provider, token: TOKEN, requireAuth: true });
  return { app };
}

function post(app: Awaited<ReturnType<typeof build>>['app'], path: string, agentId: string | null, body: unknown = {}) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(agentId ? { 'x-agent-id': agentId } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('computerd routes', () => {
  let app: Awaited<ReturnType<typeof build>>['app'];
  beforeEach(async () => {
    ({ app } = await build());
  });

  it('rejects a missing bearer before any work', async () => {
    const response = await app.request('/v1/screens/self/ensure', { method: 'POST', headers: { 'x-agent-id': 'agent-a' } });
    expect(response.status).toBe(403);
  });

  it('refuses an unknown agent instead of allocating for it', async () => {
    const response = await post(app, '/v1/screens/self/screenshot', 'not-a-real-agent');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'not_allowed' });
  });

  it("boots a real agent's screen on first tool use and then serves actions", async () => {
    const shot = await post(app, '/v1/screens/self/screenshot', 'agent-a');
    expect(shot.status).toBe(200);
    expect(await shot.json()).toMatchObject({ mimeType: 'image/png', displayNo: 1 });
  });

  it('allocates on explicit ensure with the display and controller', async () => {
    const ensured = await post(app, '/v1/screens/self/ensure', 'agent-a');
    expect(await ensured.json()).toMatchObject({ agentId: 'agent-a', displayNo: 1, controller: 'agent' });
  });

  it('refuses agent actions once the user has taken the screen over', async () => {
    await post(app, '/v1/screens/self/ensure', 'agent-a');
    const taken = await post(app, '/v1/screens/self/take-over', 'agent-a');
    expect(await taken.json()).toMatchObject({ controller: 'user' });

    const shot = await post(app, '/v1/screens/self/screenshot', 'agent-a');
    expect(shot.status).toBe(409);
    expect(await shot.json()).toMatchObject({ code: 'user_control' });
  });

  it('puts an uploaded file in the home from base64, once, and refuses a bad body or path', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 255]);
    const body = { path: 'uploads/lib-1/cv.pdf', contentBase64: bytes.toString('base64') };
    const first = await post(app, '/v1/home/put-file', 'agent-a', body);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ written: true });
    expect(await (await post(app, '/v1/home/put-file', 'agent-a', body)).json()).toMatchObject({ written: false });
    expect((await post(app, '/v1/home/put-file', 'agent-a', { ...body, contentBase64: 'not base64!' })).status).toBe(400);
    const escaped = await post(app, '/v1/home/put-file', 'agent-a', { ...body, path: '../cv.pdf' });
    expect(escaped.status).toBe(403);
    expect((await post(app, '/v1/home/extract-text', 'agent-a', { path: body.path, format: 'zip' })).status).toBe(400);
  });
});

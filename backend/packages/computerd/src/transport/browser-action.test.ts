/**
 * The owner-scoped browser action endpoint: typed dispatch through the lifecycle fence,
 * refusal of unknown agents (never allocated), and refusal while the user holds control.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { createFakeProvider, createScreenPool, MAX_LIVE_SCREENS } from '@agent-desktop/sandbox-adapters';
import type { Agent } from '@agent-desktop/public-contracts';
import { createComputerApp } from './routes.js';
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

async function build(hangAfterEnsure = false) {
  const store = createMemoryStore();
  await store.put('agents', agent('agent-a'));
  const provider = createFakeProvider();
  const act = provider.act.bind(provider);
  let hang = false;
  provider.act = (...args) => (hang ? new Promise(() => undefined) : act(...args));
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
  void hangAfterEnsure;
  return Object.assign(createComputerApp({ lifecycle, provider, token: TOKEN, requireAuth: true }), { provider, setHang: (value: boolean) => { hang = value; } });
}

function post(app: Awaited<ReturnType<typeof build>>, path: string, agentId: string | null, body: unknown = {}) {
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

describe('browser action endpoint', () => {
  let app: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    app = await build();
  });

  it('rejects an unknown action shape instead of touching the screen', async () => {
    const response = await post(app, '/v1/screens/self/browser/action', 'agent-a', { action: 'eval', code: '1' });
    expect(response.status).toBe(400);
  });

  it('refuses an unknown agent instead of allocating for it', async () => {
    const response = await post(app, '/v1/screens/self/browser/action', 'not-a-real-agent', { action: 'snapshot' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'not_allowed' });
  });

  it('refuses browser actions while the user holds control', async () => {
    await post(app, '/v1/screens/self/ensure', 'agent-a');
    await post(app, '/v1/screens/self/take-over', 'agent-a');
    const response = await post(app, '/v1/screens/self/browser/action', 'agent-a', { action: 'snapshot' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'user_control' });
  });

  it('reads tap targets while the user holds control, and never allocates a screen for them', async () => {
    const get = (agentId: string) => app.request('/v1/screens/self/elements', { headers: { authorization: `Bearer ${TOKEN}`, 'x-agent-id': agentId } });
    expect((await get('agent-a')).status).toBe(404);
    await post(app, '/v1/screens/self/ensure', 'agent-a');
    await post(app, '/v1/screens/self/take-over', 'agent-a');
    const response = await get('agent-a');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ width: 1280, height: 800, elements: [{ role: 'button', name: 'Continue' }] });
  });

  it('relaunches a dead browser and retries once, telling the agent', async () => {
    await post(app, '/v1/screens/self/ensure', 'agent-a');
    app.provider.state.browserOutages = 1;
    const response = await post(app, '/v1/screens/self/browser/action', 'agent-a', { action: 'snapshot' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: 'snapshot', restarted: true });
    expect(app.provider.state.browserOutages).toBe(0);
  });

  it('reports a browser that stays dead instead of looping', async () => {
    await post(app, '/v1/screens/self/ensure', 'agent-a');
    app.provider.state.browserOutages = 2;
    const response = await post(app, '/v1/screens/self/browser/action', 'agent-a', { action: 'snapshot' });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining('could not be restarted') });
  });

  it('hands control back with the held time and whether the agent was held up', async () => {
    await post(app, '/v1/screens/self/ensure', 'agent-a');
    await post(app, '/v1/screens/self/take-over', 'agent-a');
    await post(app, '/v1/screens/self/browser/action', 'agent-a', { action: 'snapshot' });
    const back = await (await post(app, '/v1/screens/self/return-control', 'agent-a')).json();
    expect(back).toMatchObject({ controller: 'agent', handBack: { blocked: true, changes: [] } });
    expect(back).not.toHaveProperty('takeover');
    // A second return changes nothing, so it carries no hand-back note.
    expect(await (await post(app, '/v1/screens/self/return-control', 'agent-a')).json()).not.toHaveProperty('handBack');
  });

  it('answers take-over and return-control quickly even when the sandbox never responds', async () => {
    await post(app, '/v1/screens/self/ensure', 'agent-a');
    app.setHang(true);
    const t0 = Date.now();
    const taken = await post(app, '/v1/screens/self/take-over', 'agent-a');
    expect(taken.status).toBe(200);
    expect(await taken.json()).toMatchObject({ controller: 'user' });
    const back = await post(app, '/v1/screens/self/return-control', 'agent-a');
    expect(await back.json()).toMatchObject({ controller: 'agent', handBack: { changes: ['the browser state could not be read'] } });
    expect(Date.now() - t0).toBeLessThan(8000);
  }, 12000);
});

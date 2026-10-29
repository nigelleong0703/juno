/**
 * The read-only environment endpoint: an agent with a screen gets the bound computer
 * metadata (no secrets), while unknown, foreign-owner, screenless and bindingless callers get
 * truthful errors and never trigger an allocation.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { createFakeProvider, createScreenPool, MAX_LIVE_SCREENS } from '@agent-desktop/sandbox-adapters';
import type { Agent } from '@agent-desktop/public-contracts';
import type { E2bBinding } from '@agent-desktop/contracts';
import { createComputerApp } from '../transport/routes.js';
import { createLifecycle } from '../modules/computers/lifecycle.js';
import { createComputerStateStore } from '../infrastructure/computer-state.js';

const TOKEN = 'test-token';
const NOW = new Date().toISOString();

function agent(id: string, createdBy?: string): Agent {
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
    createdAt: NOW,
    updatedAt: NOW,
    ...(createdBy ? { createdBy } : {}),
  };
}

type App = Awaited<ReturnType<typeof build>>['app'];

async function build(seed: E2bBinding | null, agents: Agent[] = [agent('agent-a')], workingDirectory?: string) {
  const store = createMemoryStore();
  for (const entry of agents) await store.put('agents', entry);
  const provider = createFakeProvider(workingDirectory ? { environment: { workingDirectory } } : {});
  const pool = createScreenPool(MAX_LIVE_SCREENS);
  const state = createComputerStateStore('', seed);
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
  return { app, store };
}

function get(app: App, path: string, agentId: string | null) {
  return app.request(path, {
    method: 'GET',
    headers: {
      authorization: 'Bearer ' + TOKEN,
      ...(agentId ? { 'x-agent-id': agentId } : {}),
    },
  });
}

function post(app: App, path: string, agentId: string, body: unknown = {}) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + TOKEN,
      'x-agent-id': agentId,
    },
    body: JSON.stringify(body),
  });
}

const SEED: E2bBinding = { sandboxId: 'sbx-test', template: 'desktop-debian' };

describe('environment endpoint', () => {
  it('serves the bound metadata for an agent with a screen, without secrets', async () => {
    const { app } = await build(SEED);
    await post(app, '/v1/screens/self/ensure', 'agent-a');
    const response = await get(app, '/v1/screens/self/environment', 'agent-a');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      user: 'agent',
      home: '/home/agent',
      workingDirectory: '/workspace',
      pathStyle: 'posix',
      kind: 'sandbox',
    });
    expect(JSON.stringify(body)).not.toContain('Password');
    expect(JSON.stringify(body)).not.toContain('password');
  });

  it('refuses an unknown agent without allocating anything', async () => {
    const { app, store } = await build(SEED);
    const response = await get(app, '/v1/screens/self/environment', 'not-a-real-agent');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'not_allowed' });
    expect((await store.list('screens', { limit: 10 })).items).toHaveLength(0);
  });

  it('never leaks the environment to a foreign-owner agent', async () => {
    const { app, store } = await build(SEED, [agent('agent-a'), agent('agent-b', 'someone-else')]);
    await post(app, '/v1/screens/self/ensure', 'agent-a');
    const response = await get(app, '/v1/screens/self/environment', 'agent-b');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'not_allowed' });
    expect((await store.list('screens', { limit: 10 })).items).toHaveLength(1);
  });

  it('reports no_screen when the binding exists but the agent has no screen', async () => {
    const { app, store } = await build(SEED);
    const response = await get(app, '/v1/screens/self/environment', 'agent-a');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'no_screen' });
    expect((await store.list('screens', { limit: 10 })).items).toHaveLength(0);
  });

  it('reports unavailable when no computer is bound, without starting one', async () => {
    const { app, store } = await build(null);
    const response = await get(app, '/v1/screens/self/environment', 'agent-a');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'unavailable' });
    expect((await store.list('screens', { limit: 10 })).items).toHaveLength(0);
  });
});

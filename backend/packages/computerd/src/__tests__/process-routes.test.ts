/**
 * computerd's process routes against the REAL Hono app and lifecycle fence (not a mocked HTTP post):
 * the bearer and the control fence decide first, an unknown agent never allocates, a taken-over screen
 * refuses the agent, and a started handle is scoped to the requesting agent inside the sandbox double.
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
    id, name: id, handle: id,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 'tester',    status: 'idle', section: 'Work', pinned: false, lastActivity: '', unreadCount: 0,
    model: {
      planner: { provider: 'scripted', model: 'test' },
      computer: { provider: 'scripted', model: 'test' },
      fast: { provider: 'scripted', model: 'test' },
    },
    channels: [], macAccess: false, skillIds: [], pluginIds: [],
    sharing: { publishedToTeam: false },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

async function build() {
  const store = createMemoryStore();
  await store.put('agents', agent('agent-a'));
  const provider = createFakeProvider();
  const lifecycle = createLifecycle({
    store, provider, pool: createScreenPool(MAX_LIVE_SCREENS),
    state: createComputerStateStore('', { sandboxId: 'sbx-test', template: 'desktop-debian' }),
    ownerId: 'owner-1',
    host: { template: 'desktop-debian', resolution: '1280x800', timeoutMs: 1000, ramGb: 2, vcpu: 2, idlePauseMinutes: 30 },
    secret: TOKEN,
  });
  return { app: createComputerApp({ lifecycle, provider, token: TOKEN, requireAuth: true }), provider };
}

type App = Awaited<ReturnType<typeof build>>['app'];

function post(app: App, path: string, agentId: string | null, body: unknown = {}, token = TOKEN) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token,
      ...(agentId ? { 'x-agent-id': agentId } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('computerd process routes', () => {
  let app: App;
  let provider: ReturnType<typeof createFakeProvider>;
  beforeEach(async () => {
    ({ app, provider } = await build());
  });

  it('requires the bearer and a real agent before any process work', async () => {
    expect((await post(app, '/v1/screens/self/processes/start', 'agent-a', { command: 'ls' }, 'wrong')).status).toBe(403);
    const unknown = await post(app, '/v1/screens/self/processes/start', 'not-a-real-agent', { command: 'ls' });
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toMatchObject({ code: 'not_allowed' });
    expect(provider.processScopes.size).toBe(0);
  });

  it('starts, polls, feeds input and stops a process, scoped to the requesting agent', async () => {
    const started = await post(app, '/v1/screens/self/processes/start', 'agent-a', { command: 'cat' });
    expect(started.status).toBe(200);
    const snapshot = await started.json() as { handle: string; state: string };
    expect(snapshot.state).toBe('running');
    expect(provider.processScopes.get(snapshot.handle)).toBe('agent-a');

    const written = await post(app, '/v1/screens/self/processes/write', 'agent-a', { handle: snapshot.handle, data: 'hi' });
    expect(await written.json()).toMatchObject({ bytes: 2 });

    const polled = await post(app, '/v1/screens/self/processes/read', 'agent-a', { handle: snapshot.handle });
    const polledBody = (await polled.json()) as { state: string; exitCode: number | null; output: string };
    expect(polledBody).toMatchObject({ state: 'running', exitCode: null });
    expect(polledBody.output).toContain('hi');

    const stopped = await post(app, '/v1/screens/self/processes/stop', 'agent-a', { handle: snapshot.handle });
    expect(await stopped.json()).toMatchObject({ state: 'stopped', exitCode: 143 });
  });

  it('refuses a process handle that belongs to another agent', async () => {
    const started = await post(app, '/v1/screens/self/processes/start', 'agent-a', { command: 'cat' });
    const handle = ((await started.json()) as { handle: string }).handle;
    const polled = await post(app, '/v1/screens/self/processes/read', 'agent-b', { handle });
    expect(polled.status).toBe(403);
    expect(await polled.json()).toMatchObject({ code: 'not_allowed' });
  });

  it('refuses process actions once the user has taken the screen over', async () => {
    await post(app, '/v1/screens/self/ensure', 'agent-a');
    await post(app, '/v1/screens/self/take-over', 'agent-a');
    const started = await post(app, '/v1/screens/self/processes/start', 'agent-a', { command: 'ls' });
    expect(started.status).toBe(409);
    expect(await started.json()).toMatchObject({ code: 'user_control' });
  });

  it('rejects an oversized input write before the sandbox is touched', async () => {
    const started = await post(app, '/v1/screens/self/processes/start', 'agent-a', { command: 'cat' });
    const handle = ((await started.json()) as { handle: string }).handle;
    const tooBig = await post(app, '/v1/screens/self/processes/write', 'agent-a', { handle, data: 'x'.repeat(65_537) });
    expect(tooBig.status).toBe(400);
  });
});

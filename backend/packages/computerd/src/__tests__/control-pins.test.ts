/**
 * The control gateway's pins (BACKEND 7.8b): what must hold for takeover and hand-back whatever process serves the call.
 * They run through the same seams production uses (the route app, two lifecycles over one store, the VNC proxy), so they
 * fail on the pre-gateway code for the behaviour, not for a missing function.
 */
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createMemoryStore } from '@agent-desktop/db';
import type { Agent } from '@agent-desktop/public-contracts';
import { createFakeProvider, createScreenPool, signScreenTicket } from '@agent-desktop/sandbox-adapters';
import { createComputerApp } from '../transport/routes.js';
import { createVncProxy } from '../transport/proxy.js';
import { createLifecycle } from '../modules/computers/lifecycle.js';
import { createComputerStateStore } from '../infrastructure/computer-state.js';
import { serverListening, socketOpen } from './ws-helpers.js';

const TOKEN = 'pin-token';
const OWNER = 'owner-1';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const agent: Agent = {
  id: 'agent-a', name: 'a', handle: 'a', avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 't', status: 'idle', section: 'Work',
  pinned: false, lastActivity: '', unreadCount: 0,
  model: { planner: { provider: 'scripted', model: 't' }, computer: { provider: 'scripted', model: 't' }, fast: { provider: 'scripted', model: 't' } },
  channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false },
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};
const host = { template: 'desktop-debian', resolution: '1280x800', timeoutMs: 1000, ramGb: 2, vcpu: 2, idlePauseMinutes: 30 };

/** One computerd "process": its own lifecycle, provider and pool, over the store every process shares. */
function processOver(store: ReturnType<typeof createMemoryStore>) {
  const provider = createFakeProvider({ sandboxId: 'sbx-shared' });
  const lifecycle = createLifecycle({
    store, provider, pool: createScreenPool(4), state: createComputerStateStore('', { sandboxId: 'sbx-shared', template: 'desktop-debian' }),
    ownerId: OWNER, host, secret: TOKEN,
  });
  const app = createComputerApp({ lifecycle, provider, token: TOKEN, requireAuth: true });
  return { provider, lifecycle, app };
}

async function setup() {
  const store = createMemoryStore();
  await store.put('agents', agent);
  const a = processOver(store);
  const b = processOver(store);
  await a.lifecycle.ensureScreen('agent-a', new AbortController().signal);
  return { store, a, b };
}

const post = (app: ReturnType<typeof processOver>['app'], path: string) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'x-agent-id': 'agent-a' }, body: '{}' });

describe('control gateway pins', () => {
  const servers: Server[] = [];
  const upstreams: WebSocketServer[] = [];
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    for (const upstream of upstreams.splice(0)) {
      for (const socket of upstream.clients) socket.terminate();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('a double or concurrent take-over reports one change', async () => {
    const { a, b } = await setup();
    const answers = await Promise.all([post(a.app, '/v1/screens/self/take-over'), post(b.app, '/v1/screens/self/take-over'), post(a.app, '/v1/screens/self/take-over')]);
    const bodies = await Promise.all(answers.map((answer) => answer.json() as Promise<{ controller: string; changed?: boolean }>));
    expect(bodies.every((body) => body.controller === 'user')).toBe(true);
    expect(bodies.filter((body) => body.changed === true)).toHaveLength(1);
    const returned = await Promise.all([post(a.app, '/v1/screens/self/return-control'), post(b.app, '/v1/screens/self/return-control')]);
    const handBacks = (await Promise.all(returned.map((answer) => answer.json() as Promise<{ handBack?: unknown }>))).filter((body) => body.handBack !== undefined);
    expect(handBacks).toHaveLength(1);
  });

  it('a write stream held by another process closes within 2 s of the hand-back', async () => {
    const { a, b } = await setup();
    await a.lifecycle.takeOver('agent-a', { via: 'api' });
    const upstream = new WebSocketServer({ port: 0 });
    upstreams.push(upstream);
    await serverListening(upstream);
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('missing upstream port');
    vi.spyOn(b.provider, 'screenStream').mockImplementation(async () => connect({ host: '127.0.0.1', port: address.port }));
    const proxy = createVncProxy({ lifecycle: b.lifecycle, provider: b.provider, secret: 'ticket-secret' });
    const server = createServer();
    servers.push(server);
    server.on('upgrade', (request, socket, head) => proxy.handleUpgrade(request, socket, head));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const screen = await b.lifecycle.getScreen('agent-a');
    if (!screen) throw new Error('no screen');
    const ticket = signScreenTicket({ screenId: screen.id, ownerId: OWNER, agentId: 'agent-a', control: true, expiresAt: Date.now() + 60_000 }, 'ticket-secret');
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/screens/${screen.id}/vnc?t=${ticket}`);
    sockets.push(socket);
    await socketOpen(socket);

    const closed = new Promise<number>((resolve) => socket.once('close', () => resolve(Date.now())));
    const returnedAt = Date.now();
    await a.lifecycle.returnControl('agent-a', { via: 'api' });
    const closedAt = await Promise.race([closed, delay(2_500).then(() => Number.POSITIVE_INFINITY)]);
    expect(closedAt - returnedAt).toBeLessThanOrEqual(2_100);
  });

  it('a take-over waits for the agent action in flight (at most 3 s) before it hands control over', async () => {
    const { a } = await setup();
    const real = a.provider.act.bind(a.provider);
    let actFinishedAt = 0;
    vi.spyOn(a.provider, 'act').mockImplementation(async (...args) => {
      if (args[3].kind === 'screenshot') await delay(700);
      const result = await real(...args);
      if (args[3].kind === 'screenshot') actFinishedAt = Date.now();
      return result;
    });
    const shot = post(a.app, '/v1/screens/self/screenshot');
    await delay(150);
    const taken = await post(a.app, '/v1/screens/self/take-over');
    const takenAt = Date.now();
    expect(taken.status).toBe(200);
    expect((await shot).status).toBe(200);
    expect(actFinishedAt).toBeGreaterThan(0);
    expect(takenAt).toBeGreaterThanOrEqual(actFinishedAt);
    expect(takenAt - actFinishedAt).toBeLessThan(3_000);
    // And nothing new gets in once control has moved.
    expect((await post(a.app, '/v1/screens/self/screenshot')).status).toBe(409);
  });

  it('an action admitted before the hand-over but still running after 3 s is aborted', async () => {
    const { a } = await setup();
    let aborted = false;
    vi.spyOn(a.provider, 'act').mockImplementation((_binding, _agent, _display, action, signal) => {
      if (action.kind !== 'screenshot') return Promise.reject(new Error('unexpected'));
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }));
    });
    const shot = post(a.app, '/v1/screens/self/screenshot');
    await delay(100);
    const started = Date.now();
    const taken = await post(a.app, '/v1/screens/self/take-over');
    expect(taken.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(4_500);
    expect(aborted).toBe(true);
    await shot;
  }, 10_000);
});

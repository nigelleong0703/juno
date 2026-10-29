import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createMemoryStore } from '@agent-desktop/db';
import { screenPorts, type ScreenDoc } from '@agent-desktop/contracts';
import { agentSchema } from '@agent-desktop/public-contracts';
import { createFakeProvider, createScreenPool, signScreenTicket, type ScreenTicketClaims } from '@agent-desktop/sandbox-adapters';
import { createLifecycle } from '../modules/computers/lifecycle.js';
import { createComputerStateStore } from '../infrastructure/computer-state.js';
import { createVncProxy, type VncProxyOptions } from '../transport/proxy.js';
import { serverListening, socketOpen } from './ws-helpers.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until the condition holds, so a real (tiny) heartbeat interval is not timing-dependent. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the heartbeat');
    await delay(10);
  }
}

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

/** Minimal valid agent row: `returnControl` re-checks the agent before it touches the screen. */
const agentFixture = agentSchema.parse({
  id: 'agent-fixture', name: 'Fixture Agent', handle: 'fixture',
  avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 'Fixture',  status: 'idle', section: 'Personal', pinned: false, lastActivity: '', unreadCount: 0,
  model: {
    planner: { provider: 'fixture', model: 'fixture' },
    computer: { provider: 'fixture', model: 'fixture' },
    fast: { provider: 'fixture', model: 'fixture' },
  },
  channels: [], macAccess: false, skillIds: [], pluginIds: [],
  sharing: { publishedToTeam: false }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});

async function scope(
  ownerId: string,
  upstream: string,
  controller: 'agent' | 'user' = 'agent',
) {
  const store = createMemoryStore();
  await store.put('agents', { ...agentFixture, id: `agent-${ownerId}` });
  const screen: ScreenDoc = {
    id: 'same-screen', ownerId, agentId: `agent-${ownerId}`, computerId: `vm-${ownerId}`,
    displayNo: 1, state: 'live', title: 'test', resolution: '1280x800',
    lastUsedAt: new Date().toISOString(), lastVncPort: screenPorts(1).vnc, lastWebPort: screenPorts(1).web,
  };
  await store.put('screens', screen, { agentId: screen.agentId, status: screen.state });
  const provider = createFakeProvider();
  // The computer link is replaced by a plain connection to the test's WebSocket server.
  const proxyUrl = vi.spyOn(provider, 'screenStream').mockImplementation(async () => connect({ host: '127.0.0.1', port: Number(new URL(upstream).port) }));
  const lifecycle = createLifecycle({
    store, provider, pool: createScreenPool(4),
    state: createComputerStateStore('', { sandboxId: `vm-${ownerId}`, template: 'test' }), ownerId, secret: 'secret',
    host: { template: 'test', resolution: '1280x800', timeoutMs: 1000, ramGb: 2, vcpu: 2, idlePauseMinutes: 30 },
  });
  // Who holds the screen is its control row: the person takes it through the gateway, as the route does.
  if (controller === 'user') await lifecycle.takeOver(screen.agentId, { via: 'api' });
  return { lifecycle, provider, proxyUrl };
}

async function listen(options: VncProxyOptions) {
  const proxy = createVncProxy(options);
  const server = createServer();
  servers.push(server);
  server.on('upgrade', (req, socket, head) => proxy.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  return { port: address.port, proxy };
}

async function upgrade(port: number, claims: ScreenTicketClaims, secret = 'secret') {
  const ticket = signScreenTicket(claims, secret);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/screens/same-screen/vnc?t=${ticket}`);
  sockets.push(socket);
  return new Promise<number>((resolve, reject) => {
    socket.once('open', () => { resolve(101); socket.close(); });
    socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); socket.terminate(); });
    socket.on('error', reject);
  });
}

const claims = (ownerId: string): ScreenTicketClaims => ({
  ownerId, agentId: `agent-${ownerId}`, screenId: 'same-screen', control: true, expiresAt: Date.now() + 30_000,
});

describe('signed proxy identity', () => {
  it('resolves only a verified ticket owner, isolates providers and refuses wrong agents', async () => {
    const upstream = new WebSocketServer({ port: 0 });
    upstreams.push(upstream);
    await serverListening(upstream);
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('missing upstream port');
    const url = `ws://127.0.0.1:${address.port}`;
    const alice = await scope('alice', url);
    const bob = await scope('bob', url);
    const forOwner = vi.fn((owner: string) => owner === 'alice' ? alice : bob);
    const { port } = await listen({ forOwner, secret: 'secret' });
    expect(await upgrade(port, claims('alice'), 'wrong-secret')).toBe(403);
    expect(forOwner).not.toHaveBeenCalled();
    expect(await upgrade(port, { ...claims('alice'), agentId: 'agent-bob' })).toBe(403);
    // A resolver returning a different owner's row is still refused by the bridge itself.
    expect(await upgrade(port, claims('unknown'))).toBe(403);
    expect(alice.proxyUrl).not.toHaveBeenCalled();
    expect(bob.proxyUrl).not.toHaveBeenCalled();
    expect(await upgrade(port, claims('alice'))).toBe(101);
    expect(alice.proxyUrl).toHaveBeenCalledWith({ sandboxId: 'vm-alice', template: 'test' }, 1, false, expect.any(AbortSignal));
    expect(bob.proxyUrl).not.toHaveBeenCalled();
    expect(await upgrade(port, claims('bob'))).toBe(101);
    expect(bob.proxyUrl).toHaveBeenCalledWith({ sandboxId: 'vm-bob', template: 'test' }, 1, false, expect.any(AbortSignal));
  });

  it('preserves legacy options but requires both owner and agent to match exactly', async () => {
    const upstream = new WebSocketServer({ port: 0 });
    upstreams.push(upstream);
    await serverListening(upstream);
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('missing upstream port');
    const legacy = await scope('legacy', `ws://127.0.0.1:${address.port}`);
    const { port } = await listen({ lifecycle: legacy.lifecycle, provider: legacy.provider, secret: 'secret' });
    expect(await upgrade(port, { ...claims('legacy'), ownerId: 'other' })).toBe(403);
    expect(await upgrade(port, { ...claims('legacy'), agentId: 'other' })).toBe(403);
    expect(legacy.proxyUrl).not.toHaveBeenCalled();
    expect(await upgrade(port, claims('legacy'))).toBe(101);
    expect(legacy.proxyUrl).toHaveBeenCalledTimes(1);
  });

  it('renews the sandbox only while the user holds writable control, and stops on revocation', async () => {
    const upstream = new WebSocketServer({ port: 0 });
    upstreams.push(upstream);
    await serverListening(upstream);
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('missing upstream port');

    // The user holds control, so the stream is writable and an open session renews the sandbox.
    const held = await scope('held', `ws://127.0.0.1:${address.port}`, 'user');
    const renewSpy = vi.spyOn(held.provider, 'connect');
    const writable = await listen({ lifecycle: held.lifecycle, provider: held.provider, secret: 'secret', keepAliveMs: 25 });
    const socket = new WebSocket(`ws://127.0.0.1:${writable.port}/v1/screens/same-screen/vnc?t=${signScreenTicket(claims('held'), 'secret')}`);
    sockets.push(socket);
    await socketOpen(socket);

    await waitFor(() => renewSpy.mock.calls.length > 0);
    expect(renewSpy).toHaveBeenCalledWith({ sandboxId: 'vm-held', template: 'test' }, expect.any(AbortSignal));

    // Returning control closes the writable stream, so the heartbeat stops touching the VM.
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await held.lifecycle.returnControl('agent-held', { via: 'api' });
    await closed;
    await delay(250);
    const settled = renewSpy.mock.calls.length;
    await delay(250);
    expect(renewSpy.mock.calls.length).toBe(settled);
  });

  it('never renews the sandbox for a read-only watcher', async () => {
    const upstream = new WebSocketServer({ port: 0 });
    upstreams.push(upstream);
    await serverListening(upstream);
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('missing upstream port');

    // The screen stays under agent control, so the same ticket is a read-only watch.
    const watched = await scope('watched', `ws://127.0.0.1:${address.port}`, 'agent');
    const renewSpy = vi.spyOn(watched.provider, 'connect');
    const watcher = await listen({ lifecycle: watched.lifecycle, provider: watched.provider, secret: 'secret', keepAliveMs: 25 });
    const socket = new WebSocket(`ws://127.0.0.1:${watcher.port}/v1/screens/same-screen/vnc?t=${signScreenTicket(claims('watched'), 'secret')}`);
    sockets.push(socket);
    await socketOpen(socket);

    await delay(150);
    expect(renewSpy).not.toHaveBeenCalled();
  });

  it('returning control revokes the writable stream and stops its heartbeat', async () => {
    const upstream = new WebSocketServer({ port: 0 });
    upstreams.push(upstream);
    await serverListening(upstream);
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('missing upstream port');

    const held = await scope('held', `ws://127.0.0.1:${address.port}`, 'user');
    const renewSpy = vi.spyOn(held.provider, 'connect');
    const writable = await listen({ lifecycle: held.lifecycle, provider: held.provider, secret: 'secret', keepAliveMs: 25 });

    const socket = new WebSocket(`ws://127.0.0.1:${writable.port}/v1/screens/same-screen/vnc?t=${signScreenTicket(claims('held'), 'secret')}`);
    sockets.push(socket);
    await socketOpen(socket);
    await waitFor(() => renewSpy.mock.calls.length > 0);

    // Returning control is the stored truth: it must drop the stream, not wait for a client unmount.
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await held.lifecycle.returnControl('agent-held', { via: 'api' });
    await closed;
    await delay(250);
    const settled = renewSpy.mock.calls.length;
    await delay(250);
    expect(renewSpy.mock.calls.length).toBe(settled);
  });

  it('re-ensures the persisted display before opening a stream after a provider restart', async () => {
    const upstream = new WebSocketServer({ port: 0 });
    upstreams.push(upstream);
    await serverListening(upstream);
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('missing upstream port');

    // A computerd restart drops the provider's in-process displays while the screen row stays 'live'.
    const legacy = await scope('legacy', `ws://127.0.0.1:${address.port}`);
    legacy.provider.screens.clear();
    const { port } = await listen({ lifecycle: legacy.lifecycle, provider: legacy.provider, secret: 'secret' });
    expect(legacy.provider.screens.size).toBe(0);

    expect(await upgrade(port, claims('legacy'))).toBe(101);
    // The display was re-ensured on the SAME sandbox, not a newly created one.
    expect(legacy.provider.screens.size).toBe(1);
    expect(legacy.proxyUrl).toHaveBeenCalledWith({ sandboxId: 'vm-legacy', template: 'test' }, 1, false, expect.any(AbortSignal));
  });
});

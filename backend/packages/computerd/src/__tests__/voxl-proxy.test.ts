/**
 * The voxl proxy against a fake voxl (a plain HTTP + WebSocket server standing in for the process on the computer's loopback):
 * the ticket and platform token gate it, a ticket's `control` only counts while the person holds the screen (else the read-only
 * instance is used), voxl's password is injected server-side and the browser's cookie and Origin never reach voxl.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createMemoryStore } from '@agent-desktop/db';
import { screenPorts, type ScreenDoc } from '@agent-desktop/contracts';
import { agentSchema } from '@agent-desktop/public-contracts';
import { createFakeProvider, createScreenPool, signScreenTicket, type ScreenTicketClaims } from '@agent-desktop/sandbox-adapters';
import { createLifecycle } from '../modules/computers/lifecycle.js';
import { createComputerStateStore } from '../infrastructure/computer-state.js';
import { createVoxlProxy, TICKET_HEADER, TOKEN_HEADER } from '../transport/voxl-proxy.js';

const servers: Server[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const agentFixture = agentSchema.parse({
  id: 'agent-a', name: 'A', handle: 'a', avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 'A', status: 'idle', section: 'Personal', pinned: false,
  lastActivity: '', unreadCount: 0,
  model: { planner: { provider: 'f', model: 'f' }, computer: { provider: 'f', model: 'f' }, fast: { provider: 'f', model: 'f' } },
  channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});

const listen = async (server: Server): Promise<number> => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
};

/** A fake voxl: records the headers and the path of every request, answers /healthz and echoes websocket text. */
async function fakeVoxl() {
  const seen: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
  const server = createServer((request, response) => {
    seen.push({ path: request.url ?? '', headers: request.headers });
    response.writeHead(request.url === '/denied' ? 401 : 200, { 'content-type': 'text/plain', 'set-cookie': 'voxl=1', 'www-authenticate': 'Basic' });
    response.end('ok:' + request.url);
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, request) => {
    seen.push({ path: request.url ?? '', headers: request.headers });
    socket.on('message', (data) => socket.send('echo:' + String(data)));
  });
  return { port: await listen(server), seen };
}

async function setup(controller: 'agent' | 'user', voxlPort: number) {
  const store = createMemoryStore();
  await store.put('agents', agentFixture);
  const screen: ScreenDoc = {
    id: 'screen-1', ownerId: 'alice', agentId: 'agent-a', computerId: 'vm-1', displayNo: 1, state: 'live', title: 't', resolution: '1280x800',
    lastUsedAt: new Date().toISOString(), lastVncPort: screenPorts(1).vnc, lastWebPort: screenPorts(1).web,
  };
  await store.put('screens', screen, { agentId: screen.agentId, status: screen.state });
  const provider = createFakeProvider();
  const voxlStream = vi.spyOn(provider, 'voxlStream').mockImplementation(async () => connect({ host: '127.0.0.1', port: voxlPort }));
  const lifecycle = createLifecycle({
    store, provider, pool: createScreenPool(4), state: createComputerStateStore('', { sandboxId: 'vm-1', template: 'test' }), ownerId: 'alice', secret: 'secret',
    host: { template: 'test', resolution: '1280x800', timeoutMs: 1000, ramGb: 2, vcpu: 2, idlePauseMinutes: 30 },
  });
  if (controller === 'user') await lifecycle.takeOver('agent-a', { via: 'api' });
  const proxy = createVoxlProxy({ forOwner: () => ({ lifecycle, provider }), token: 'platform', secret: 'ticket-secret' });
  const server = createServer((request, response) => (proxy.matches(request.url) ? proxy.handleRequest(request, response) : response.writeHead(404).end()));
  server.on('upgrade', (request, socket, head) => proxy.handleUpgrade(request, socket, head));
  const secrets = lifecycle.vncSecrets(screen);
  return { port: await listen(server), voxlStream, secrets };
}

const claims = (over: Partial<ScreenTicketClaims> = {}): ScreenTicketClaims => ({ screenId: 'screen-1', ownerId: 'alice', agentId: 'agent-a', control: true, expiresAt: Date.now() + 30_000, ...over });
const ticketOf = (c: ScreenTicketClaims, secret = 'ticket-secret') => signScreenTicket(c, secret);

async function get(port: number, path: string, headers: Record<string, string>) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/screens/screen-1/voxl/${path}`, { headers });
  return { status: response.status, body: await response.text(), headers: response.headers };
}
const good = (c = claims()) => ({ [TOKEN_HEADER]: 'platform', [TICKET_HEADER]: ticketOf(c) });

describe('voxl proxy', () => {
  it('refuses a missing token, a forged or expired ticket and a ticket for another screen before touching the computer', async () => {
    const voxl = await fakeVoxl();
    const { port, voxlStream } = await setup('user', voxl.port);
    expect((await get(port, 'healthz', { [TICKET_HEADER]: ticketOf(claims()) })).status).toBe(403);
    expect((await get(port, 'healthz', { ...good(), [TOKEN_HEADER]: 'nope' })).status).toBe(403);
    expect((await get(port, 'healthz', { ...good(), [TICKET_HEADER]: ticketOf(claims(), 'other') })).status).toBe(403);
    expect((await get(port, 'healthz', good(claims({ expiresAt: Date.now() - 1 })))).status).toBe(403);
    expect((await get(port, 'healthz', good(claims({ screenId: 'screen-2' })))).status).toBe(403);
    expect((await get(port, 'healthz', good(claims({ ownerId: 'mallory' })))).status).toBe(403);
    expect(voxlStream).not.toHaveBeenCalled();
    expect(voxl.seen).toHaveLength(0);
  });

  it('injects the control password only while the person holds the screen, else the read-only instance and password', async () => {
    const voxl = await fakeVoxl();
    const driving = await setup('user', voxl.port);
    const reply = await get(driving.port, 'screenshot?x=1', { ...good(), cookie: 'session=secret', origin: 'https://evil.example', referer: 'https://evil.example/', authorization: 'Bearer browser', accept: 'image/png' });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('ok:/screenshot?x=1');
    // voxl's own cookie and challenge never reach the browser.
    expect(reply.headers.get('set-cookie')).toBeNull();
    expect(reply.headers.get('www-authenticate')).toBeNull();
    const seen = voxl.seen[0]!;
    expect(seen.headers.authorization).toBe(`Bearer ${driving.secrets.controlPassword}`);
    expect(seen.headers.host).toBe('localhost');
    expect(seen.headers.accept).toBe('image/png');
    for (const name of ['cookie', 'origin', 'referer', TOKEN_HEADER, TICKET_HEADER]) expect(seen.headers[name], name).toBeUndefined();
    expect(driving.voxlStream).toHaveBeenCalledWith({ sandboxId: 'vm-1', template: 'test' }, 1, true, expect.any(AbortSignal));

    // The agent holds the screen: the same control ticket only gets the watcher's instance.
    const watching = await setup('agent', voxl.port);
    await get(watching.port, '', good());
    expect(watching.voxlStream).toHaveBeenCalledWith({ sandboxId: 'vm-1', template: 'test' }, 1, false, expect.any(AbortSignal));
    expect(voxl.seen[1]!.headers.authorization).toBe(`Bearer ${watching.secrets.viewPassword}`);
  });

  it('turns voxl refusing the platform password into a 502, not a browser sign-in prompt', async () => {
    const voxl = await fakeVoxl();
    const { port } = await setup('agent', voxl.port);
    const reply = await get(port, 'denied', good(claims({ control: false })));
    expect(reply.status).toBe(502);
    expect(reply.headers.get('www-authenticate')).toBeNull();
  });

  it('bridges only /ws, with the password and without the browser Origin', async () => {
    const voxl = await fakeVoxl();
    const { port, secrets } = await setup('agent', voxl.port);
    const open = (path: string, headers: Record<string, string>) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/screens/screen-1/voxl/${path}`, { headers });
      sockets.push(socket);
      return socket;
    };
    const message = await new Promise<string>((resolve, reject) => {
      const socket = open('ws', { ...good(claims({ control: false })), origin: 'https://computer.example' });
      socket.once('open', () => socket.send('hi'));
      socket.once('message', (data) => resolve(String(data)));
      socket.once('error', reject);
    });
    expect(message).toBe('echo:hi');
    const upgrade = voxl.seen.at(-1)!;
    expect(upgrade.headers.authorization).toBe(`Bearer ${secrets.viewPassword}`);
    expect(upgrade.headers.origin).toBeUndefined();
    const status = await new Promise<number>((resolve) => {
      const socket = open('files/list', good());
      socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      socket.once('error', () => undefined);
    });
    expect(status).toBe(404);
  });
});

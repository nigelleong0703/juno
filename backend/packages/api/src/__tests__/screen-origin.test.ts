/** The screen host: ticket in the path, nothing but the ticket as credential, everything else forwarded to computerd with the platform's own. */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { signScreenTicket } from '@agent-desktop/sandbox-adapters';
import { createScreenOrigin, parseScreenPath } from '../screen-origin.js';
import { checkEdgeHosts, hostKind } from '../edge-hosts.js';

const SECRET = 'ticket-secret';
const claims = { screenId: 'screen-1', ownerId: 'alice', agentId: 'agent-a', control: true, expiresAt: Date.now() + 60_000 };
const ticket = signScreenTicket(claims, SECRET);
const HOST = 'computer.example.test';

const servers: Server[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const origin = (over: { fetch?: typeof fetch; url?: string } = {}) =>
  createScreenOrigin({
    secret: SECRET, computerd: { url: over.url ?? 'http://computerd.internal', token: 'platform' }, scheme: 'https',
    frameAncestors: ['https://app.example'], ...(over.fetch ? { fetch: over.fetch } : {}),
  });
const request = (path: string, init: RequestInit = {}) => new Request(`https://${HOST}${path}`, { ...init, headers: { host: HOST, ...(init.headers as Record<string, string>) } });

describe('screen host paths', () => {
  it('parses only genuine, unexpired tickets', () => {
    expect(parseScreenPath(`/s/${ticket}/ws`, SECRET)?.rest).toBe('ws');
    expect(parseScreenPath(`/s/${ticket}`, SECRET)?.rest).toBeUndefined();
    expect(parseScreenPath(`/s/${ticket}/`, SECRET)?.rest).toBe('');
    expect(parseScreenPath(`/s/${ticket}/ws`, 'other')).toBeNull();
    expect(parseScreenPath(`/s/${ticket}/ws`, SECRET, claims.expiresAt)).toBeNull();
    expect(parseScreenPath('/healthz', SECRET)).toBeNull();
  });

  it('is its own host kind and keeps the isolation rules of the other hosts', () => {
    const hosts = { artifactHost: 'usercontent.example', spaceDomain: 'spaces.example', screenHost: HOST };
    expect(hostKind(HOST, hosts)).toBe('screen');
    expect(hostKind('api.example.test', hosts)).toBe('api');
    expect(hostKind(HOST, { ...hosts, screenHost: undefined })).toBe('api');
    const base = { apiOrigin: 'https://api.example.test', artifactHost: 'usercontent.example', spaceDomain: 'spaces.example' };
    expect(() => checkEdgeHosts({ ...base, screenHost: 'api.example.test' })).toThrow(/must not equal or contain/);
    expect(() => checkEdgeHosts({ ...base, screenHost: 'example.test' })).toThrow(/must not equal or contain/);
    expect(() => checkEdgeHosts({ ...base, screenHost: 'usercontent.example' })).toThrow(/collides/);
    expect(() => checkEdgeHosts({ ...base, screenHost: 'abcdefgh.spaces.example' })).toThrow(/collides/);
    // Same registrable domain as the API is accepted for this host only (a warning), unlike the artifact and space hosts.
    expect(checkEdgeHosts({ ...base, screenHost: HOST })).toEqual([expect.stringContaining('SCREEN_HOST')]);
    expect(checkEdgeHosts({ ...base, screenHost: 'computer.other.example' })).toEqual([]);
  });
});

describe('screen host requests', () => {
  it('refuses a bad ticket, redirects a path without the slash, and rejects methods and foreign origins', async () => {
    const send = vi.fn();
    const app = origin({ fetch: send as never }).app;
    expect((await app.fetch(request('/s/garbage/'))).status).toBe(403);
    expect((await app.fetch(request(`/s/${ticket}?stats`))).headers.get('location')).toBe(`/s/${ticket}/?stats`);
    expect((await app.fetch(request(`/s/${ticket}/files/upload`, { method: 'PUT', body: 'x' }))).status).toBe(405);
    expect((await app.fetch(request(`/s/${ticket}/record/start`, { method: 'POST', headers: { origin: 'https://evil.example' } }))).status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('forwards with the platform credentials only and answers without cookies, framable by the app', async () => {
    let seen: { url: string; headers: Headers } | undefined;
    const send = vi.fn(async (url: URL, init: RequestInit) => {
      seen = { url: String(url), headers: new Headers(init.headers) };
      return new Response('page', { status: 200, headers: { 'content-type': 'text/html', 'set-cookie': 'a=b', 'cache-control': 'no-cache' } });
    });
    const app = origin({ fetch: send as never }).app;
    const reply = await app.fetch(request(`/s/${ticket}/index.html?stats`, { headers: { cookie: 'session=x', authorization: 'Bearer user', accept: 'text/html' } }));
    expect(reply.status).toBe(200);
    expect(await reply.text()).toBe('page');
    expect(seen?.url).toBe('http://computerd.internal/v1/screens/screen-1/voxl/index.html?stats');
    expect(seen?.headers.get('x-juno-computerd-token')).toBe('platform');
    expect(seen?.headers.get('x-juno-screen-ticket')).toBe(ticket);
    expect(seen?.headers.get('accept')).toBe('text/html');
    expect(seen?.headers.get('cookie')).toBeNull();
    expect(seen?.headers.get('authorization')).toBeNull();
    expect(reply.headers.get('set-cookie')).toBeNull();
    expect(reply.headers.get('cache-control')).toBe('private, no-store');
    expect(reply.headers.get('content-security-policy')).toBe('frame-ancestors https://app.example');
  });

  it('is off (503) without the computerd token', async () => {
    const app = createScreenOrigin({ secret: SECRET, computerd: { url: 'http://x', token: '' }, scheme: 'https', frameAncestors: [] }).app;
    expect((await app.fetch(request(`/s/${ticket}/`))).status).toBe(503);
  });
});

describe('screen host websocket', () => {
  it('bridges /ws to computerd with the platform credentials and reports presence', async () => {
    const received: IncomingHttpHeaders[] = [];
    const urls: string[] = [];
    const computerd = createServer();
    servers.push(computerd);
    const wss = new WebSocketServer({ server: computerd });
    wss.on('connection', (socket, req) => {
      received.push(req.headers);
      urls.push(req.url ?? '');
      socket.on('message', (data) => socket.send('echo:' + String(data)));
    });
    await new Promise<void>((resolve) => computerd.listen(0, '127.0.0.1', resolve));
    const computerdPort = (computerd.address() as { port: number }).port;

    const onWatch = vi.fn();
    const screen = createScreenOrigin({ secret: SECRET, computerd: { url: `http://127.0.0.1:${computerdPort}`, token: 'platform' }, scheme: 'https', frameAncestors: [], onWatch });
    const edge = createServer();
    servers.push(edge);
    edge.on('upgrade', (req, socket, head) => screen.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => edge.listen(0, '127.0.0.1', resolve));
    const edgePort = (edge.address() as { port: number }).port;

    const socket = new WebSocket(`ws://127.0.0.1:${edgePort}/s/${ticket}/ws`, { headers: { host: HOST, origin: `https://${HOST}`, cookie: 'session=x' } });
    sockets.push(socket);
    const reply = await new Promise<string>((resolve, reject) => {
      socket.once('open', () => socket.send('hi'));
      socket.once('message', (data) => resolve(String(data)));
      socket.once('error', reject);
    });
    expect(reply).toBe('echo:hi');
    expect(urls[0]).toBe('/v1/screens/screen-1/voxl/ws');
    expect(received[0]?.['x-juno-computerd-token']).toBe('platform');
    expect(received[0]?.['x-juno-screen-ticket']).toBe(ticket);
    expect(received[0]?.cookie).toBeUndefined();
    expect(onWatch).toHaveBeenCalledWith({ ownerId: 'alice', agentId: 'agent-a' }, true);

    // Another site's page, a bad ticket and any other path never reach computerd.
    const refused = (path: string, headers: Record<string, string>) => new Promise<number>((resolve) => {
      const other = new WebSocket(`ws://127.0.0.1:${edgePort}${path}`, { headers: { host: HOST, ...headers } });
      sockets.push(other);
      other.once('unexpected-response', (_req, response) => resolve(response.statusCode ?? 0));
      other.once('error', () => undefined);
    });
    expect(await refused(`/s/${ticket}/ws`, { origin: 'https://evil.example' })).toBe(403);
    expect(await refused('/s/garbage/ws', {})).toBe(403);
    expect(await refused(`/s/${ticket}/files`, {})).toBe(404);
    expect(received).toHaveLength(1);
  });
});

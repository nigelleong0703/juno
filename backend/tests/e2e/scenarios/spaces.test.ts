import { aguiInput } from '../../agui-input.js';
import { createHash, createHmac } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createAccount, hostRequest, listenEvents, request, scriptModel, stackUrls, toolCall, waitForIdle, waitForToolActivity, type ScriptedTurn } from '../harness/client';

// Each step chains several tool calls on the shared fake computer; with the full suite running in parallel a step can take
// well over the default 30 s (alone the whole test takes ~15 s), so the waits and the test get more room.
const WAIT_MS = 90_000;
vi.setConfig({ testTimeout: 360_000 });

/**
 * Spaces (BACKEND 5.12): space_publish allocates a port and, once the app listens, registers it; the owner opens the app
 * through a signed link that sets a session cookie on the app's own subdomain; every other request needs that cookie.
 *
 * What the fake computer can and cannot show. It runs the REAL gateway script (under Node) on a loopback port with its own
 * routes file, and the real API listener, computerd routes, tool and store. It does NOT run iptables, the root-only route
 * file, Bun or the agent's Linux user: "listening" means "something on this host accepts a connection on that port"
 * (the stub app below), and the kernel's uid check is covered by the LIVE_DOCKER test in sandbox-adapters.
 */
const SLUG = 'notes';
const publish = (id: string, args: Record<string, unknown>): ScriptedTurn => ({ toolCalls: [toolCall(id, 'space_publish', args)] });
const fillers = (count: number): ScriptedTurn[] => Array.from({ length: count }, () => ({ text: '.' }));

const spaceRequest = hostRequest;

/** A WebSocket handshake by hand; resolves with the status and, on 101, the first bytes the app sent. */
function spaceSocket(host: string, headers: Record<string, string>): Promise<{ status: number; first?: string }> {
  const target = new URL(stackUrls().spaceUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: target.hostname, port: target.port, path: '/socket',
      headers: { host, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'), ...headers },
    });
    req.on('upgrade', (res, socket) => {
      socket.once('data', (data: Buffer) => { socket.destroy(); resolve({ status: res.statusCode ?? 0, first: data.subarray(2).toString('utf8') }); });
    });
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode ?? 0 }); });
    req.on('error', () => resolve({ status: 0 }));
    req.setTimeout(10_000, () => req.destroy(new Error('socket handshake timed out')));
    req.end();
  });
}

/** The user's app: echoes what it receives, sets a cookie of its own, and answers a WebSocket handshake with one "hello" frame. */
function startApp(port: number): Promise<Server & { dropSockets(): void }> {
  const upgraded = new Set<Duplex>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/echo') {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'app=1; Path=/' });
        res.end(JSON.stringify({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>Hello from the stub app</h1>');
    });
  });
  server.on('upgrade', (req, socket) => {
    upgraded.add(socket);
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.from([0x81, 5, ...Buffer.from('hello')]));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(Object.assign(server, { dropSockets: () => { server.closeAllConnections(); for (const socket of upgraded) socket.destroy(); } })));
  });
}

/** A token minted like the API does, to prove the listener refuses forged, expired and misdirected ones. */
function token(secret: string, claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
}

describe('spaces', () => {
  it('allocates a port, publishes once the app listens, and lets only the owner in through the session cookie', async () => {
    const alice = await createAccount('spc-alice');
    const bob = await createAccount('spc-bob');
    const agent = await alice.api('POST', '/v1/agents', { name: 'Builder' });
    const other = await alice.api('POST', '/v1/agents', { name: 'Other' });
    expect(agent.status).toBe(201);
    const events = await listenEvents(alice.cookie);
    let app: (Server & { dropSockets(): void }) | undefined;
    try {
      const created = await alice.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      const conversationId: string = created.body.id;
      const sessionKey = `${agent.body.id}:${conversationId}`;
      const dir = `/workspace/spaces/${SLUG}`;
      // Wait for the previous run to end first: a message sent during its last model call would steer into it and drop that turn, shifting the script.
      const say = async (text: string) => {
        await waitForIdle(events, conversationId);
        expect((await alice.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }))).status).toBe(202);
      };

      // ---- run 1: a path outside /workspace/spaces is refused; the right folder gets a port, and no card yet.
      scriptModel(sessionKey, [publish('p1', { path: '/workspace/notes', title: 'Notes' }), publish('p2', { path: dir, title: 'Notes' }), { text: 'allocated' }]);
      await say('build me a notes app');
      const first = (await waitForToolActivity(sessionKey, (a) => a.results.filter((r) => r.toolName === 'space_publish').length >= 2, WAIT_MS)).results.filter((r) => r.toolName === 'space_publish');
      expect(first.map((r) => r.isError)).toEqual([true, false]);
      expect(first[0]?.text).toContain('/workspace/spaces/<slug>');
      const port = Number(/Allocated port (\d+)/.exec(first[1]?.text ?? '')?.[1]);
      const spaceId = /spaceId (sp[0-9a-f]+)/.exec(first[1]?.text ?? '')?.[1] ?? '';
      expect(port).toBeGreaterThanOrEqual(7100);
      expect(spaceId).toMatch(/^sp[0-9a-f]{24}$/);
      expect((await alice.api('GET', `/v1/conversations/${conversationId}/items?limit=50`)).body.items.filter((i: { type: string }) => i.type === 'artifact')).toHaveLength(0);
      expect((await alice.api('GET', '/v1/spaces')).body.items).toEqual([]);

      // ---- run 2: nothing listens yet, so registration fails with the reason; another agent cannot take the folder.
      scriptModel(sessionKey, [...fillers(3), publish('p3', { path: dir, title: 'Notes' }), { text: 'not yet' }]);
      await say('is it up?');
      const second = await waitForToolActivity(sessionKey, (a) => a.results.filter((r) => r.toolName === 'space_publish').length >= 3, WAIT_MS);
      const refused = second.results.filter((r) => r.toolName === 'space_publish')[2];
      expect(refused?.isError).toBe(true);
      expect(refused?.text).toContain(`nothing is listening on port ${port}`);

      const otherChat = await alice.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [other.body.id] });
      const otherKey = `${other.body.id}:${otherChat.body.id}`;
      scriptModel(otherKey, [publish('q1', { path: dir, title: 'Mine now' }), { text: 'x' }]);
      expect((await alice.api('POST', `/v1/conversations/${otherChat.body.id}/runs`, aguiInput(`/v1/conversations/${otherChat.body.id}/runs`, { text: 'take the folder' }))).status).toBe(202);
      const taken = (await waitForToolActivity(otherKey, (a) => a.results.some((r) => r.toolName === 'space_publish'), WAIT_MS)).results[0];
      expect(taken?.isError).toBe(true);
      expect(taken?.text).toContain('belongs to another agent');

      // ---- run 3: the app is up on its port; the next publish registers it and posts the card.
      app = await startApp(port);
      scriptModel(sessionKey, [...fillers(5), publish('p4', { path: dir, title: 'Notes' }), { text: 'published' }]);
      await say('now?');
      const third = await waitForToolActivity(sessionKey, (a) => a.results.filter((r) => r.toolName === 'space_publish').length >= 4, WAIT_MS);
      const ok = third.results.filter((r) => r.toolName === 'space_publish')[3];
      expect(ok?.isError).toBe(false);
      expect(ok?.text).toContain(`spaceId ${spaceId}`);

      const cards = (await alice.api('GET', `/v1/conversations/${conversationId}/items?limit=50`)).body.items.filter((i: { type: string }) => i.type === 'artifact') as Array<{ artifactId: string }>;
      expect(cards).toHaveLength(1);
      const card = await alice.api('GET', `/v1/artifacts/${cards[0]?.artifactId}`);
      expect(card.body).toMatchObject({ name: 'Notes', render: 'app', spaceId });
      expect(card.body.versions).toBeUndefined();

      // ---- the API: owner-only, with the live status.
      const listed = await alice.api('GET', '/v1/spaces');
      expect(listed.body.items).toHaveLength(1);
      expect(listed.body.items[0]).toMatchObject({ id: spaceId, title: 'Notes', slug: SLUG, agentId: agent.body.id, artifactId: cards[0]?.artifactId, status: 'running' });
      expect((await alice.api('GET', `/v1/spaces/${spaceId}`)).body.status).toBe('running');
      expect((await request('GET', '/v1/spaces')).status).toBe(401);
      expect((await request('POST', `/v1/spaces/${spaceId}/open-url`)).status).toBe(401);
      expect((await bob.api('GET', '/v1/spaces')).body.items).toEqual([]);
      expect((await bob.api('GET', `/v1/spaces/${spaceId}`)).status).toBe(404);
      expect((await bob.api('POST', `/v1/spaces/${spaceId}/open-url`)).status).toBe(404);
      expect((await alice.api('POST', '/v1/spaces/spdoesnotexist000000000000/open-url')).status).toBe(404);

      // ---- open: a signed link on the app's own subdomain sets the session cookie.
      const opened = await alice.api('POST', `/v1/spaces/${spaceId}/open-url`);
      expect(opened.status).toBe(200);
      const link = new URL(opened.body.url);
      const host = link.host;
      expect(host).toBe(`${spaceId}.${stackUrls().spaceDomain}`);
      expect(link.pathname).toBe('/__juno/auth');
      const ttl = Date.parse(opened.body.expiresAt) - Date.now();
      expect(ttl).toBeGreaterThan(4 * 60_000);
      expect(ttl).toBeLessThanOrEqual(5 * 60_000);

      const secret = stackUrls().spaceUrlSecret;
      const claims = { spaceId, ownerId: alice.userId, expiresAt: Date.now() + 60_000 };
      const authPath = (t: string) => `/__juno/auth?token=${t}`;
      for (const bad of [
        '',
        'garbage',
        link.searchParams.get('token')?.slice(0, -2) + 'xx',
        token('wrong-secret', { kind: 'open', ...claims }),
        token(secret, { kind: 'open', ...claims, expiresAt: Date.now() - 1000 }),
        token(secret, { kind: 'open', ...claims, spaceId: 'spaaaaaaaaaaaaaaaaaaaaaaaa' }),
        token(secret, { kind: 'session', ...claims }),
        token(secret, { kind: 'open', ...claims, ownerId: bob.userId }),
      ]) {
        const refusedOpen = await spaceRequest(host, authPath(bad ?? ''));
        expect(refusedOpen.status).toBe(403);
        expect(refusedOpen.headers['set-cookie']).toBeUndefined();
      }
      expect((await spaceRequest(host, '/__juno/auth', { method: 'POST' })).status).toBe(403);

      const granted = await spaceRequest(host, link.pathname + link.search);
      expect(granted.status).toBe(302);
      expect(granted.headers.location).toBe('/');
      const setCookie = String(granted.headers['set-cookie']?.[0]);
      expect(setCookie).toMatch(/^juno_space=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
      expect(setCookie).not.toContain('Domain');
      const session = /^juno_space=([^;]+)/.exec(setCookie)?.[1] ?? '';
      const cookie = `juno_space=${session}`;

      // ---- without a valid cookie nothing gets through.
      expect((await spaceRequest(host, '/')).status).toBe(401);
      expect((await spaceRequest(host, '/', { headers: { cookie: 'juno_space=garbage' } })).status).toBe(401);
      expect((await spaceRequest(host, '/', { headers: { cookie: `juno_space=${token(secret, { kind: 'open', ...claims })}` } })).status).toBe(401);
      expect((await spaceRequest(host, '/', { headers: { cookie: `juno_space=${token(secret, { kind: 'session', ...claims, ownerId: bob.userId })}` } })).status).toBe(401);
      expect((await spaceRequest(host, '/', { headers: { cookie: `juno_space=${token(secret, { kind: 'session', ...claims, expiresAt: Date.now() - 1000 })}` } })).status).toBe(401);
      // The cookie is bound to the app: it opens nothing else, and unknown hosts are not found.
      const otherHost = `spaaaaaaaaaaaaaaaaaaaaaaaaa.${stackUrls().spaceDomain}`;
      expect((await spaceRequest(otherHost, '/', { headers: { cookie } })).status).toBe(401);
      expect((await spaceRequest(`127.0.0.1:${new URL(stackUrls().apiUrl).port}`, '/', { headers: { cookie } })).status).toBe(404);
      expect((await spaceRequest(`nope.${stackUrls().spaceDomain}`, '/', { headers: { cookie } })).status).toBe(404);

      // The api on the same port is untouched by the app routing, and its on-demand TLS check answers yes only for a real app.
      const apiHost = new URL(stackUrls().apiUrl).host;
      expect((await spaceRequest(apiHost, '/healthz')).status).toBe(200);
      const bareDomain = stackUrls().spaceDomain.replace(/:\d+$/, '');
      const tlsCheck = (domain: string) => fetch(`${stackUrls().apiUrl}/v1/edge/tls-check?domain=${encodeURIComponent(domain)}`);
      expect((await tlsCheck(`${spaceId}.${bareDomain}`)).status).toBe(200);
      expect((await tlsCheck(`spaaaaaaaaaaaaaaaaaaaaaaaaa.${bareDomain}`)).status).toBe(404);
      expect((await tlsCheck(`${spaceId}.evil.test`)).status).toBe(404);
      expect((await tlsCheck(bareDomain)).status).toBe(404);
      expect((await tlsCheck(stackUrls().artifactHost.replace(/:\d+$/, ''))).status).toBe(200);
      expect((await fetch(`${stackUrls().apiUrl}/v1/edge/tls-check`)).status).toBe(404);

      // ---- with it, the app answers; platform headers and our cookie never reach it, its own cookie passes both ways.
      const page = await spaceRequest(host, '/', { headers: { cookie } });
      expect(page.status).toBe(200);
      expect(page.body).toContain('Hello from the stub app');
      const echoed = await spaceRequest(host, '/echo', { method: 'POST', body: 'ping', headers: { cookie: `${cookie}; mine=1`, 'x-owner-id': 'evil', 'x-juno-space': 'spother', 'x-forwarded-for': '6.6.6.6', origin: `http://${host}`, 'content-type': 'text/plain' } });
      expect(echoed.status).toBe(200);
      const seen = JSON.parse(echoed.body) as { method: string; body: string; headers: Record<string, string> };
      expect(seen.method).toBe('POST');
      expect(seen.body).toBe('ping');
      expect(seen.headers['cookie']).toBe('mine=1');
      expect(JSON.stringify(seen.headers)).not.toContain(session);
      expect(seen.headers['x-owner-id']).toBeUndefined();
      expect(seen.headers['x-juno-space']).toBeUndefined();
      expect(seen.headers['x-forwarded-for']).toBeUndefined();
      expect(seen.headers['x-forwarded-host']).toBe(host);
      expect(echoed.headers['set-cookie']).toEqual(['app=1; Path=/']);
      // A page of another app cannot act as the owner here (same-site cookie, other origin).
      expect((await spaceRequest(host, '/echo', { method: 'POST', body: 'x', headers: { cookie, origin: `http://${otherHost}` } })).status).toBe(403);

      // ---- the gateway answers 404 without the computer's key, even for a real space id; the only way to it is computerd's proxy (the computer publishes no port).
      const platform = (path: string) => fetch(stackUrls().computerdUrl + path, { method: 'POST', headers: { authorization: `Bearer ${stackUrls().computerdToken}`, 'x-owner-id': alice.userId, 'content-type': 'application/json' }, body: '{}' });
      const { key } = (await (await platform('/v1/spaces/gateway')).json()) as { key: string };
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      const viaProxy = (path: string, headers: Record<string, string> = {}, token = stackUrls().computerdToken) =>
        fetch(stackUrls().computerdUrl + '/v1/spaces/gateway-proxy' + path, { headers: { 'x-juno-computerd-token': token, 'x-juno-owner': alice.userId, ...headers } });
      expect((await viaProxy('/', {}, 'wrong-token')).status).toBe(403);
      expect((await viaProxy('/', { 'x-juno-space': spaceId })).status).toBe(404);
      expect((await viaProxy('/', { 'x-juno-space': spaceId, 'x-juno-gateway-key': 'f'.repeat(64) })).status).toBe(404);
      expect((await viaProxy('/', { 'x-juno-space': spaceId, 'x-juno-gateway-key': key.slice(0, 63) })).status).toBe(404);
      const direct = await viaProxy('/echo', { 'x-juno-space': spaceId, 'x-juno-gateway-key': key, authorization: 'Bearer apps-own-credential' });
      expect(direct.status).toBe(200);
      const directHeaders = JSON.stringify(((await direct.json()) as { headers: object }).headers);
      expect(directHeaders).not.toContain('gateway-key');
      // The platform's credentials stop at computerd; the app's own Authorization header passes.
      expect(directHeaders).not.toContain(stackUrls().computerdToken);
      expect(directHeaders).not.toContain('x-juno-computerd-token');
      expect(directHeaders).toContain('apps-own-credential');
      expect((await viaProxy('/__status')).status).toBe(404);
      expect(await (await viaProxy('/__status', { 'x-juno-gateway-key': key })).json()).toEqual({ listening: [spaceId] });
      // The key comes only from the platform: what the browser sends is replaced, what the app receives has none.
      expect(echoed.body).not.toContain(key);

      // ---- WebSocket goes through the same checks and the gateway.
      expect(await spaceSocket(host, { cookie })).toEqual({ status: 101, first: 'hello' });
      expect((await spaceSocket(host, {})).status).toBe(401);
      expect((await spaceSocket(host, { cookie, origin: `http://${otherHost}` })).status).toBe(403);

      // ---- run 4: publishing again with the spaceId updates the same card.
      // The first publish also emitted artifact.updated (before the card), so wait for the one that carries the new title.
      const update = events.waitFor((e) => e.data.type === 'artifact.updated' && e.data.artifact.id === cards[0]?.artifactId && e.data.artifact.name === 'Notes v2');
      scriptModel(sessionKey, [...fillers(7), publish('p5', { path: dir, title: 'Notes v2', spaceId }), publish('p6', { path: dir, title: 'Wrong', spaceId: 'spnosuchspace0000000000000' }), { text: 'updated' }]);
      await say('rename it');
      const fourth = await waitForToolActivity(sessionKey, (a) => a.results.filter((r) => r.toolName === 'space_publish').length >= 6, WAIT_MS);
      const [renamed, unknown] = fourth.results.filter((r) => r.toolName === 'space_publish').slice(4);
      expect(renamed?.isError).toBe(false);
      expect(renamed?.text).toContain('Updated');
      expect(unknown?.isError).toBe(true);
      expect((await update).data.artifact).toMatchObject({ name: 'Notes v2', render: 'app', spaceId });
      expect((await alice.api('GET', `/v1/spaces/${spaceId}`)).body.title).toBe('Notes v2');
      expect((await alice.api('GET', `/v1/conversations/${conversationId}/items?limit=50`)).body.items.filter((i: { type: string }) => i.type === 'artifact')).toHaveLength(1);

      // ---- status polling neither resumes a paused computer nor wakes it; real traffic does.
      expect((await platform('/v1/computer/pause')).status).toBe(200);
      expect((await alice.api('GET', `/v1/spaces/${spaceId}`)).body.status).toBe('computer_paused');
      expect((await alice.api('GET', '/v1/spaces')).body.items[0].status).toBe('computer_paused');
      expect((await alice.api('GET', `/v1/spaces/${spaceId}`)).body.status).toBe('computer_paused');
      // The API reuses a gateway address for 5 seconds; past that, a real request asks computerd again, which resumes the computer.
      await new Promise((done) => setTimeout(done, 5_500));
      expect((await spaceRequest(host, '/', { headers: { cookie } })).status).toBe(200);
      expect((await alice.api('GET', `/v1/spaces/${spaceId}`)).body.status).toBe('running');

      // ---- the app stops: the status says so and the gateway answers for it.
      app.dropSockets();
      await new Promise((done) => app?.close(done));
      app = undefined;
      expect((await alice.api('GET', `/v1/spaces/${spaceId}`)).body.status).toBe('not_listening');
      expect((await spaceRequest(host, '/', { headers: { cookie } })).status).toBe(502);
    } finally {
      events.close();
      app?.dropSockets();
      app?.close();
    }
  });
});

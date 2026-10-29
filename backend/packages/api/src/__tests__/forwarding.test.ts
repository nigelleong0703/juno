/**
 * Owner/service forwarding: the gateway authenticates with the session, then speaks
 * upstream as itself. Spoofed owner headers, user tokens and cookies never cross the
 * boundary; redirects are never followed; internal cookies are dropped; query, method,
 * body, status and streams pass through untouched with a header-only time bound.
 */
import { IncomingMessage, createServer } from 'node:http';
import { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { WebSocket, WebSocketServer } from 'ws';
import { signScreenTicket } from '@agent-desktop/sandbox-adapters';
import { createApiApp } from '../server.js';
import type { ApiAuth } from '../server.js';
import { COMPUTER_PROVISION_TIMEOUT_MS, HEADER_TIMEOUT_MS, forwardToAgentd } from '../proxy.js';
import type { ForwardDeps } from '../proxy.js';
import { createStreamProxy } from '../stream-proxy.js';

const UPSTREAM = 'http://127.0.0.1:8788';
const SERVICE_TOKEN = 'service-token-abc';

interface SeenRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  signal: AbortSignal | null;
}

function testAuth(sessions: Record<string, string>): ApiAuth {
  const map = new Map(Object.entries(sessions));
  return {
    info: { mode: 'account', providers: ['credential'] },
    handle: async () => new Response('auth', { status: 200 }),
    resolve: async (req) => {
      const header = req.headers.get('authorization');
      const token = header && header.startsWith('Bearer ') ? header.slice(7) : null;
      const ownerId = token ? map.get(token) : undefined;
      return ownerId ? { ownerId } : null;
    },
  };
}

function readBody(rawBody: unknown): string {
  if (typeof rawBody === 'string') return rawBody;
  if (rawBody instanceof ArrayBuffer) return Buffer.from(rawBody).toString('utf8');
  return '';
}

function gateway(seen: SeenRequest[], respond: (seen: SeenRequest) => Response): ReturnType<typeof createApiApp> {
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request: SeenRequest = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: readBody(init?.body),
      signal: init?.signal ?? null,
    };
    seen.push(request);
    return respond(request);
  };
  return createApiApp({ auth: testAuth({ 'sess-abc': 'user-123' }), agentdUrl: UPSTREAM, internalToken: SERVICE_TOKEN, fetch: fetchFn });
}

function directProxy(deps: ForwardDeps): Hono {
  const app = new Hono();
  app.all('/v1/*', (c) => forwardToAgentd(c, 'user-123', deps));
  return app;
}

describe('anonymous requests', () => {
  it('rejects /v1 without a session and never contacts upstream', async () => {
    const seen: SeenRequest[] = [];
    const app = gateway(seen, () => Response.json({ items: [] }));
    const res = await app.request('/v1/agents');
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('rejects /v1 when the resolver throws, without contacting upstream', async () => {
    const seen: SeenRequest[] = [];
    const broken: ApiAuth = {
      info: { mode: 'account', providers: ['credential'] },
      handle: async () => new Response('auth', { status: 200 }),
      resolve: async () => {
        throw new Error('session store down');
      },
    };
    const unreachable: typeof fetch = async () => {
      seen.push({ url: '', method: '', headers: new Headers(), body: '', signal: null });
      return Response.json({});
    };
    const app = createApiApp({ auth: broken, agentdUrl: UPSTREAM, internalToken: SERVICE_TOKEN, fetch: unreachable });
    const res = await app.request('/v1/agents', { headers: { Authorization: 'Bearer sess-abc' } });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });
});

describe('upstream identity', () => {
  it('sends the service bearer and authoritative owner, drops spoofed headers', async () => {
    const seen: SeenRequest[] = [];
    const app = gateway(seen, () => Response.json({ items: [] }));
    const res = await app.request('/v1/agents', {
      headers: {
        Authorization: 'Bearer sess-abc',
        Cookie: 'better-auth.session_token=sess-abc; other=1',
        'x-owner-id': 'attacker-eve',
        'x-owner': 'attacker-eve',
      },
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const upstream = seen[0];
    if (!upstream) throw new Error('expected one upstream request');
    expect(upstream.headers.get('authorization')).toBe('Bearer ' + SERVICE_TOKEN);
    expect(upstream.headers.get('x-owner-id')).toBe('user-123');
    expect(upstream.headers.get('cookie')).toBeNull();
    expect(upstream.headers.get('x-owner')).toBeNull();
    expect(upstream.signal).toBeInstanceOf(AbortSignal);
  });

  it('never forwards the user token', async () => {
    const seen: SeenRequest[] = [];
    const app = gateway(seen, () => Response.json({ ok: true }));
    await app.request('/v1/agents', { headers: { Authorization: 'Bearer sess-abc' } });
    const upstream = seen[0];
    if (!upstream) throw new Error('expected one upstream request');
    const sent = upstream.headers.get('authorization') ?? '';
    expect(sent).not.toContain('sess-abc');
  });
});

describe('request fidelity', () => {
  it('preserves query, method, body and JSON status', async () => {
    const seen: SeenRequest[] = [];
    const app = gateway(seen, () => Response.json({ created: true }, { status: 201 }));
    const res = await app.request('/v1/conversations/abc/runs?after=42', {
      method: 'POST',
      headers: { Authorization: 'Bearer sess-abc', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ created: true });
    const upstream = seen[0];
    if (!upstream) throw new Error('expected one upstream request');
    expect(upstream.url).toBe(UPSTREAM + '/v1/conversations/abc/runs?after=42');
    expect(upstream.method).toBe('POST');
    expect(JSON.parse(upstream.body)).toEqual({ text: 'hello' });
  });

  it('streams SSE bodies without buffering the whole payload', async () => {
    const seen: SeenRequest[] = [];
    const app = gateway(seen, () => {
      const stream = new ReadableStream<string>({
        start(controller) {
          controller.enqueue('event: reset\n\n');
          controller.enqueue('data: one\n\n');
          controller.enqueue('data: two\n\n');
          controller.close();
        },
      });
      return new Response(stream.pipeThrough(new TextEncoderStream()), {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const res = await app.request('/v1/events?after=7', {
      headers: { Authorization: 'Bearer sess-abc' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toBe('event: reset\n\ndata: one\n\ndata: two\n\n');
    const upstream = seen[0];
    if (!upstream) throw new Error('expected one upstream request');
    expect(upstream.url).toBe(UPSTREAM + '/v1/events?after=7');
  });

  it('forwards the events cursor as plain JSON and keeps the stream path exact', async () => {
    const seen: SeenRequest[] = [];
    const app = gateway(seen, () => Response.json({ after: 800 }));
    const res = await app.request('/v1/events/cursor', { headers: { Authorization: 'Bearer sess-abc' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ after: 800 });
    expect(seen[0]?.url).toBe(UPSTREAM + '/v1/events/cursor');

    // The resume cursor travels as a header on the stream and must reach the private service intact.
    const resumed: SeenRequest[] = [];
    const resumeApp = gateway(resumed, () => new Response('', { headers: { 'content-type': 'text/event-stream' } }));
    await resumeApp.request('/v1/events', { headers: { Authorization: 'Bearer sess-abc', 'Last-Event-ID': '800' } });
    expect(resumed[0]?.headers.get('last-event-id')).toBe('800');

    // Only the listed method+path pairs reach the private service.
    const unlisted = await app.request('/v1/events/cursor', { method: 'POST', headers: { Authorization: 'Bearer sess-abc' } });
    expect(unlisted.status).toBe(404);
    expect(seen).toHaveLength(1);
  });

  it('returns 502 when the private service is unreachable', async () => {
    const failingFetch: typeof fetch = () => Promise.reject(new Error('connection refused'));
    const app = createApiApp({
      auth: testAuth({ 'sess-abc': 'user-123' }),
      agentdUrl: UPSTREAM,
      internalToken: SERVICE_TOKEN,
      fetch: failingFetch,
    });
    const res = await app.request('/v1/agents', {
      headers: { Authorization: 'Bearer sess-abc' },
    });
    expect(res.status).toBe(502);
  });
});

describe('redirect and cookie boundary', () => {
  it('never follows an upstream redirect with the authoritative owner', async () => {
    let calls = 0;
    const fetchFn: typeof fetch = async (input, init) => {
      calls += 1;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://evil.example/x') return Response.json({ stolen: false });
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } });
    };
    const app = directProxy({ agentdUrl: UPSTREAM, internalToken: SERVICE_TOKEN, fetchFn });
    const res = await app.request('/v1/agents');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://evil.example/x');
    expect(calls).toBe(1);
  });

  it('strips private set-cookie from the client response', async () => {
    const fetchFn: typeof fetch = async () =>
      new Response('ok', { headers: { 'set-cookie': 'internal=1; HttpOnly', 'content-type': 'text/plain' } });
    const app = directProxy({ agentdUrl: UPSTREAM, internalToken: SERVICE_TOKEN, fetchFn });
    const res = await app.request('/v1/agents');
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('content-type')).toContain('text/plain');
  });
});

describe('header-only time bound', () => {
  it('returns 504 when upstream headers never arrive', async () => {
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const app = directProxy({ agentdUrl: UPSTREAM, internalToken: SERVICE_TOKEN, fetchFn: hangingFetch, headerTimeoutMs: 30 });
    const res = await app.request('/v1/agents');
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({
      error: { code: 'GATEWAY_TIMEOUT', message: 'Private agentd did not respond in time' },
    });
  });

  it('lets a slow stream run past the header bound once headers arrive', async () => {
    const slowFetch: typeof fetch = async () => {
      const stream = new ReadableStream<string>({
        start(controller) {
          setTimeout(() => {
            controller.enqueue('data: late\n\n');
            controller.close();
          }, 80);
        },
      });
      return new Response(stream.pipeThrough(new TextEncoderStream()), {
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    const app = directProxy({ agentdUrl: UPSTREAM, internalToken: SERVICE_TOKEN, fetchFn: slowFetch, headerTimeoutMs: 30 });
    const res = await app.request('/v1/events');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('data: late\n\n');
  });
});

describe('screen stream entry', () => {
  const SECRET = 'ticket-secret-for-tests-only';

  function upgrade(url: string): { req: IncomingMessage; channel: PassThrough } {
    const channel = new PassThrough();
    const req = new IncomingMessage(new Socket());
    req.url = url;
    return { req, channel };
  }

  function refusedText(channel: PassThrough): string {
    const chunk = channel.read();
    return chunk === null ? '' : String(chunk);
  }

  it('refuses paths outside the screen stream', () => {
    const proxy = createStreamProxy({ computerdUrl: 'http://127.0.0.1:8791', ticketSecret: SECRET });
    const { req, channel } = upgrade('/v1/agents');
    proxy.handleUpgrade(req, channel, Buffer.alloc(0));
    expect(refusedText(channel)).toContain('404');
  });

  it('refuses forged tickets without contacting computerd', () => {
    const proxy = createStreamProxy({ computerdUrl: 'http://127.0.0.1:8791', ticketSecret: SECRET });
    const { req, channel } = upgrade('/v1/screens/screen-1/vnc?t=forged');
    proxy.handleUpgrade(req, channel, Buffer.alloc(0));
    expect(refusedText(channel)).toContain('403');
  });

  it('reports the viewer once when a screen stream opens and once when it closes', async () => {
    const computerd = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => computerd.once('listening', () => resolve()));
    const port = (computerd.address() as { port: number }).port;
    const notices: Array<[string, string, boolean]> = [];
    const proxy = createStreamProxy({
      computerdUrl: `http://127.0.0.1:${port}`, ticketSecret: SECRET,
      onWatch: ({ ownerId, agentId }, watching) => notices.push([ownerId, agentId, watching]),
    });
    const gatewayServer = createServer();
    gatewayServer.on('upgrade', (req, socket, head) => proxy.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => gatewayServer.listen(0, '127.0.0.1', () => resolve()));
    const gatewayPort = (gatewayServer.address() as { port: number }).port;
    const ticket = signScreenTicket(
      { screenId: 'screen-1', ownerId: 'user-123', agentId: 'agent-1', control: false, expiresAt: Date.now() + 60000 },
      SECRET,
    );
    try {
      const viewer = new WebSocket(`ws://127.0.0.1:${gatewayPort}/v1/screens/screen-1/vnc?t=${encodeURIComponent(ticket)}`);
      await vi.waitFor(() => expect(notices).toEqual([['user-123', 'agent-1', true]]));
      viewer.close();
      await vi.waitFor(() => expect(notices).toEqual([['user-123', 'agent-1', true], ['user-123', 'agent-1', false]]));
    } finally {
      gatewayServer.close();
      computerd.close();
    }
  });

  it('refuses a ticket minted for a different screen', () => {
    const proxy = createStreamProxy({ computerdUrl: 'http://127.0.0.1:8791', ticketSecret: SECRET });
    const ticket = signScreenTicket(
      { screenId: 'screen-1', ownerId: 'user-123', agentId: 'agent-1', control: false, expiresAt: Date.now() + 60000 },
      SECRET,
    );
    const { req, channel } = upgrade('/v1/screens/screen-2/vnc?t=' + encodeURIComponent(ticket));
    proxy.handleUpgrade(req, channel, Buffer.alloc(0));
    expect(refusedText(channel)).toContain('403');
  });
});

describe('computer provisioning budget', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fetch that never resolves until the proxy aborts it; counts how often it was called. */
  function hangingFetch(calls: { count: number }): typeof fetch {
    return (_input, init) =>
      new Promise((_resolve, reject) => {
        calls.count += 1;
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
  }

  it('lets a provisioning POST outlast the ordinary header bound', async () => {
    const slowProvision: typeof fetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, HEADER_TIMEOUT_MS + 5000));
      return Response.json({ id: 'computer-user-123' });
    };
    const app = directProxy({ agentdUrl: UPSTREAM, internalToken: SERVICE_TOKEN, fetchFn: slowProvision });

    const pending = app.request('/v1/computers/ensure', { method: 'POST' });
    await vi.advanceTimersByTimeAsync(HEADER_TIMEOUT_MS + 5000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'computer-user-123' });
  });

  it('still times out an ordinary API at the ordinary bound', async () => {
    const calls = { count: 0 };
    const app = directProxy({ agentdUrl: UPSTREAM, internalToken: SERVICE_TOKEN, fetchFn: hangingFetch(calls) });

    const pending = app.request('/v1/agents');
    await vi.advanceTimersByTimeAsync(HEADER_TIMEOUT_MS + 1);
    const res = await pending;
    expect(res.status).toBe(504);
    expect(calls.count).toBe(1);
  });

  it('bounds a slow provision at the longer budget without replaying it', async () => {
    const calls = { count: 0 };
    const app = directProxy({ agentdUrl: UPSTREAM, internalToken: SERVICE_TOKEN, fetchFn: hangingFetch(calls) });

    const pending = Promise.resolve(app.request('/v1/computers/computer-1/screens', { method: 'POST' }));
    await vi.advanceTimersByTimeAsync(HEADER_TIMEOUT_MS + 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    // Past the ordinary bound the provision is still allowed to be booting.
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(COMPUTER_PROVISION_TIMEOUT_MS);
    const res = await pending;
    expect(res.status).toBe(504);
    expect(calls.count).toBe(1);
  });

  it('propagates a caller abort mid-provision instead of waiting', async () => {
    const calls = { count: 0 };
    const app = directProxy({ agentdUrl: UPSTREAM, internalToken: SERVICE_TOKEN, fetchFn: hangingFetch(calls) });
    const controller = new AbortController();

    const pending = app.request('/v1/computers/ensure', { method: 'POST', signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    const res = await pending;
    expect(res.status).toBe(499);
    expect(calls.count).toBe(1);
  });

  it('honors an explicit headerTimeoutMs override on a provisioning route', async () => {
    const calls = { count: 0 };
    const app = directProxy({
      agentdUrl: UPSTREAM,
      internalToken: SERVICE_TOKEN,
      fetchFn: hangingFetch(calls),
      headerTimeoutMs: 30,
    });

    const pending = app.request('/v1/computers/ensure', { method: 'POST' });
    await vi.advanceTimersByTimeAsync(31);
    const res = await pending;
    expect(res.status).toBe(504);
  });
});

describe('owner email for channel connect', () => {
  function withEmail(seen: SeenRequest[]): ReturnType<typeof createApiApp> {
    const fetchFn: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: '', signal: null });
      return new Response('{}', { status: 200 });
    };
    const auth: ApiAuth = { ...testAuth({ 'sess-abc': 'user-123' }), resolve: async () => ({ ownerId: 'user-123', email: 'me@example.com' }) };
    return createApiApp({ auth, agentdUrl: UPSTREAM, internalToken: SERVICE_TOKEN, fetch: fetchFn });
  }

  it('forwards the account email on a chat app install only, and drops a spoofed header', async () => {
    const seen: SeenRequest[] = [];
    const app = withEmail(seen);
    const headers = { authorization: 'Bearer sess-abc', 'content-type': 'application/json', 'x-owner-email': 'evil@example.com' };
    await app.request('/v1/apps/slack/install', { method: 'POST', headers, body: '{}' });
    await app.request('/v1/apps', { headers });
    expect(seen[0]?.headers.get('x-owner-email')).toBe('me@example.com');
    expect(seen[1]?.headers.get('x-owner-email')).toBeNull();
  });
});

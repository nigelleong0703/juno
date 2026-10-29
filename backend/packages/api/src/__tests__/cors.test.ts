/**
 * Browser access to the public API, the only service a browser reaches (agentd is loopback-only and has no
 * CORS). Moved here from agentd's events test, which exercised a test-only app instead of this gateway.
 */
import { describe, expect, it } from 'vitest';
import { createApiApp } from '../server.js';
import type { ApiAuth } from '../server.js';

const auth: ApiAuth = {
  info: { mode: 'account', providers: ['credential'] },
  handle: async () => new Response('auth', { status: 200 }),
  resolve: async (req) => (req.headers.get('authorization') === 'Bearer sess-abc' ? { ownerId: 'user-123' } : null),
};

/** The upstream answers the SSE stream with an empty event stream. */
const upstream: typeof fetch = async () =>
  new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });

const gateway = () => createApiApp({ auth, agentdUrl: 'http://127.0.0.1:8788', internalToken: 'service-token', fetch: upstream });

describe('public API CORS', () => {
  it.each(['http://localhost:5199', 'http://127.0.0.1:5199', 'null'])(
    'allows bearer preflight and authenticated SSE from %s',
    async (origin) => {
      const app = gateway();
      const preflight = await app.request('/v1/events', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,last-event-id' },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(preflight.headers.get('Access-Control-Allow-Credentials')).toBe('true');
      expect(preflight.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('authorization');
      const unauthorized = await app.request('/v1/events', { headers: { Origin: origin } });
      expect(unauthorized.status).toBe(401);
      const stream = await app.request('/v1/events', { headers: { Authorization: 'Bearer sess-abc', Origin: origin } });
      expect(stream.status).toBe(200);
      expect(stream.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      await stream.body?.cancel();
    },
  );

  it('does not grant CORS access to arbitrary browser origins', async () => {
    const app = gateway();
    const origin = 'https://untrusted.example';
    const preflight = await app.request('/v1/events', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } });
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const stream = await app.request('/v1/events', { headers: { Authorization: 'Bearer sess-abc', Origin: origin } });
    expect(stream.headers.get('Access-Control-Allow-Origin')).toBeNull();
    await stream.body?.cancel();
  });
});

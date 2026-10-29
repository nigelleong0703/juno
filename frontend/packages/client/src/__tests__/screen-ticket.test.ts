import { describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../http/client.js';
import { normalizeScreenStreamTicket } from '../http/screen-ticket.js';

const screenId = 'screen-123';
const path = `/v1/screens/${screenId}/vnc`;
const query = '?t=signed%2Ftoken%2B%3D&control=1&t=second&empty=';
const ticket = { url: `ws://forwarded.example${path}${query}`, expiresAt: '2030-10-06T00:00:00.000Z' };

describe('first-party screen ticket origin', () => {
  it.each([
    ['https://forwarded.example', `wss://forwarded.example${path}${query}`],
    ['https://api.example:9443/base', `wss://api.example:9443${path}${query}`],
    ['http://127.0.0.1:8787', `ws://127.0.0.1:8787${path}${query}`],
    ['http://[::1]:8787', `ws://[::1]:8787${path}${query}`],
  ])('uses the exact configured HTTP API origin %s, preserving query and expiry', (api, expected) => {
    const normalized = normalizeScreenStreamTicket(ticket, screenId, api);
    expect(normalized).toEqual({ ...ticket, url: expected });
    expect(ticket.url).toBe(`ws://forwarded.example${path}${query}`);
  });

  it('never connects to an issued foreign host, even for a matching first-party route', () => {
    const normalized = normalizeScreenStreamTicket({ ...ticket, url: `wss://foreign.example${path}${query}` }, screenId, 'https://configured.example');
    expect(normalized.url).toBe(`wss://configured.example${path}${query}`);
    expect(new URL(normalized.url).host).not.toBe('foreign.example');
  });

  it('matches the encoded screen ID and retains all additional DTO fields', () => {
    const extended = { ...ticket, url: 'ws://internal/v1/screens/screen%2Fspecial/vnc?t=keep%2Bbytes', metadata: { displayNo: 4 } };
    const normalized = normalizeScreenStreamTicket(extended, 'screen/special', 'https://configured.example');
    expect(normalized).toEqual({ ...extended, url: 'wss://configured.example/v1/screens/screen%2Fspecial/vnc?t=keep%2Bbytes' });
  });

  it.each([
    'not-a-url', `/v1/screens/${screenId}/vnc?t=token`,
    `https://configured.example${path}?t=token`,
    'wss://vendor.example/third-party/socket?t=token',
    'wss://configured.example/v1/screens/other-screen/vnc?t=token',
    `wss://configured.example${path}/extra?t=token`,
    `wss://user:password@configured.example${path}?t=token`,
    `wss://configured.example${path}?t=token#fragment`,
    `wss://configured.example${path}?t=raw token`,
  ])('rejects malformed or unrelated endpoints: %s', (url) => {
    expect(() => normalizeScreenStreamTicket({ ...ticket, url }, screenId, 'https://configured.example')).toThrow();
  });

  it.each(['file:///tmp/api', 'ws://api.example', 'https://user:password@api.example'])('rejects an invalid configured API origin %s', (api) => {
    expect(() => normalizeScreenStreamTicket(ticket, screenId, api)).toThrow();
  });
});

describe('HTTP streamScreen integration', () => {
  it('normalizes a forwarded HTTP ticket for HTTPS without changing the DTO, options or other requests', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(ticket), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const client = createHttpClient({ baseUrl: 'https://forwarded.example', getToken: () => 'session', fetch: fetcher });
    expect(await client.computers.streamScreen(screenId, { control: true })).toEqual({ ...ticket, url: `wss://forwarded.example${path}${query}` });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('https://forwarded.example/v1/screens/screen-123/stream');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"control":true}');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer session');
  });

  it('rejects an unrelated websocket URL before handing it to the renderer', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ...ticket, url: 'wss://vendor.example/socket?t=private' }), { status: 200 }));
    const client = createHttpClient({ baseUrl: 'https://configured.example', getToken: () => 'session', fetch: fetcher });
    await expect(client.computers.streamScreen(screenId)).rejects.toThrow('requested agentd VNC route');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

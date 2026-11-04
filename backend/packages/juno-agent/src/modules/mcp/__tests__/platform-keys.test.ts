import { afterEach, describe, expect, it } from 'vitest';
import { HttpMcpTransport } from '../http-transport.js';
import { isStoredHostedEndpoint } from '../../tools/net/guardedFetch.js';
import { hostedMcpHeaders, platformKeyHeaders } from '../platform-keys.js';

/** The deployment's Maps key goes only to the Maps MCP origin, whatever URL a connection names. */
describe('platform key header', () => {
  const previous = process.env.GOOGLE_MAPS_API_KEY;
  afterEach(() => {
    if (previous === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = previous;
  });

  async function headersSentTo(url: string): Promise<Headers> {
    let sent = new Headers();
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      sent = new Headers(init?.headers);
      return Response.json({ jsonrpc: '2.0', id: 1, result: {} });
    }) as typeof fetch;
    await new HttpMcpTransport({ url, fetchImpl }).request(1, 'ping', {}).catch(() => undefined);
    return sent;
  }

  it('is sent to mapstools only, and not at all without a key', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-maps-key';
    expect((await headersSentTo('https://mapstools.googleapis.com/mcp')).get('x-goog-api-key')).toBe('test-maps-key');
    expect((await headersSentTo('https://mapstools.googleapis.com.evil.example/mcp')).get('x-goog-api-key')).toBeNull();
    expect((await headersSentTo('http://mapstools.googleapis.com/mcp')).get('x-goog-api-key')).toBeNull();
    delete process.env.GOOGLE_MAPS_API_KEY;
    expect((await headersSentTo('https://mapstools.googleapis.com/mcp')).get('x-goog-api-key')).toBeNull();
  });
});

/** The hosted connectors are internal (api modules/hosted-mcp-auth.ts): the service credential goes to our own hosted paths only. */
describe('hosted connector credential', () => {
  it('Authorization is the service credential and the owner token moves to X-Upstream-Authorization', () => {
    expect(hostedMcpHeaders('Bearer ya29.owner', { HOSTED_MCP_TOKEN: 'svc' })).toEqual({ authorization: 'Bearer svc', 'x-upstream-authorization': 'Bearer ya29.owner' });
    expect(hostedMcpHeaders(undefined, { HOSTED_MCP_TOKEN: 'svc' })).toEqual({ authorization: 'Bearer svc' });
    expect(hostedMcpHeaders('Bearer x', {})).toEqual({ 'x-upstream-authorization': 'Bearer x' });
  });

  it('only the stored path form is hosted: any absolute URL (a custom server, an old origin) is not', () => {
    for (const path of ['/mcp/google/gmail', '/mcp/google/youtube', '/mcp/google/outlook-mail']) expect(isStoredHostedEndpoint(path), path).toBe(true);
    for (const value of ['https://gw.example/mcp/google/gmail', 'http://127.0.0.1:8787/mcp/google/gmail', '/mcp/hevy', '//evil.example/mcp/google/gmail', '/other/mcp', '/.well-known/oauth-protected-resource/mcp/google/gmail']) expect(isStoredHostedEndpoint(value), value).toBe(false);
  });
});

describe('the transport on hosted and other servers', () => {
  const previous = { token: process.env.HOSTED_MCP_TOKEN, url: process.env.BETTER_AUTH_URL };
  afterEach(() => {
    if (previous.token === undefined) delete process.env.HOSTED_MCP_TOKEN; else process.env.HOSTED_MCP_TOKEN = previous.token;
    if (previous.url === undefined) delete process.env.BETTER_AUTH_URL; else process.env.BETTER_AUTH_URL = previous.url;
  });

  /** `hosted: true` unless said otherwise: the connection's stored endpoint is a hosted path. */
  async function sentTo(url: string, extra: { headers?: Record<string, string>; hosted?: boolean } = {}): Promise<Headers> {
    process.env.HOSTED_MCP_TOKEN = 'svc-secret';
    process.env.BETTER_AUTH_URL = 'https://gw.example';
    let sent = new Headers();
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      sent = new Headers(init?.headers);
      return Response.json({ jsonrpc: '2.0', id: 1, result: {} });
    }) as typeof fetch;
    await new HttpMcpTransport({ url, fetchImpl, hosted: true, authorize: async () => 'Bearer owner-token', ...extra }).request(1, 'ping', {}).catch(() => undefined);
    return sent;
  }

  it('a hosted connector gets the service credential and the owner token in separate headers', async () => {
    const sent = await sentTo('https://gw.example/mcp/google/gmail');
    expect(sent.get('authorization')).toBe('Bearer svc-secret');
    expect(sent.get('x-upstream-authorization')).toBe('Bearer owner-token');
  });

  it('a custom or third-party MCP server never receives the service credential, and keeps the owner token in Authorization', async () => {
    for (const url of ['https://mcp.third-party.example/mcp', 'https://mcp.third-party.example/mcp/google/gmail', 'https://gw.example.evil.example/mcp/google/gmail']) {
      const sent = await sentTo(url, { headers: { 'x-api-key': 'custom' }, hosted: false });
      expect(sent.get('authorization'), url).toBe('Bearer owner-token');
      expect(sent.get('x-upstream-authorization'), url).toBeNull();
      expect([...sent.values()].join('\n'), url).not.toContain('svc-secret');
    }
  });

  it('a connection that is not from a hosted catalog entry never gets it, even with a hosted url', async () => {
    const sent = await sentTo('https://gw.example/mcp/google/gmail', { hosted: false });
    expect(sent.get('authorization')).toBe('Bearer owner-token');
    expect(sent.get('x-upstream-authorization')).toBeNull();
    expect([...sent.values()].join('\n')).not.toContain('svc-secret');
  });

  it('a hosted connector set up with its own Authorization header still gets only the service credential there', async () => {
    const sent = await sentTo('https://gw.example/mcp/google/gmail', { headers: { authorization: 'Bearer planted', 'x-upstream-authorization': 'Bearer planted' } });
    expect(sent.get('authorization')).toBe('Bearer svc-secret');
    expect(sent.get('x-upstream-authorization')).toBe('Bearer owner-token');
  });
});

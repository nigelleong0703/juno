import { afterEach, describe, expect, it } from 'vitest';
import { HttpMcpTransport } from '../http-transport.js';
import { platformKeyHeaders } from '../platform-keys.js';

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

describe('hosted platform-key server', () => {
  const env = { YOUTUBE_API_KEY: 'yt', INTERNAL_AGENTD_TOKEN: 'svc', BETTER_AUTH_URL: 'https://gw.example/' };
  it('gets the internal service token on this gateway only', () => {
    expect(platformKeyHeaders('https://gw.example/mcp/google/youtube', env)).toEqual({ authorization: 'Bearer svc' });
    expect(platformKeyHeaders('https://evil.example/mcp/google/youtube', env)).toEqual({});
    expect(platformKeyHeaders('https://gw.example/mcp/google/gmail', env)).toEqual({});
    expect(platformKeyHeaders('https://gw.example/mcp/google/youtube', { ...env, YOUTUBE_API_KEY: '' })).toEqual({});
  });
  it('Singapore transport needs LTA_ACCOUNT_KEY', () => {
    expect(platformKeyHeaders('https://gw.example/mcp/sg/sg-transport', env)).toEqual({});
    expect(platformKeyHeaders('https://gw.example/mcp/sg/sg-transport', { ...env, LTA_ACCOUNT_KEY: 'lta' })).toEqual({ authorization: 'Bearer svc' });
  });
});

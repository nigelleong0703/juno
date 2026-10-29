import { describe, it, expect } from 'vitest';
import { isBlockedAddress, targetsPrivateNetwork } from '../net/addressGuard.js';
import { safeFetch, UnsafeTargetError, type Hop, type RawResponse, type ResolvedAddress } from '../net/safeFetch.js';

const PUBLIC_IP = '93.184.216.34';
const page = (status: number, extra: Record<string, string | undefined> = {}): RawResponse => ({
  status,
  headers: { 'content-type': 'text/html; charset=utf-8', ...extra },
  body: Buffer.from('<title>T</title>ok'),
  truncated: false,
});

describe('address guard', () => {
  it('blocks loopback, private, link-local, metadata and mapped-private addresses', () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '172.16.9.1', '192.168.1.1', '169.254.169.254', '100.100.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
    expect(isBlockedAddress(PUBLIC_IP)).toBe(false);
  });

  it('judges URLs by name for browser.navigate and web_fetch', () => {
    for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest', 'http://10.0.0.5', 'http://2130706433/', 'http://intranet/', 'http://db.internal/', 'http://[::ffff:127.0.0.1]/', 'file:///etc/passwd', 'not a url']) {
      expect(targetsPrivateNetwork(url), url).toBe(true);
    }
    expect(targetsPrivateNetwork('https://example.com/page')).toBe(false);
  });
});

describe('safeFetch', () => {
  it('refuses a private literal without touching the transport', async () => {
    const calls: Hop[] = [];
    await expect(safeFetch({ url: 'http://127.0.0.1:8080/', maxBytes: 1000, timeoutMs: 1000, request: async (hop) => (calls.push(hop), page(200)) }))
      .rejects.toBeInstanceOf(UnsafeTargetError);
    expect(calls).toHaveLength(0);
  });

  it('refuses a name when any resolved address is private (DNS answer checked, not the name)', async () => {
    const resolve = async (): Promise<ResolvedAddress[]> => [
      { address: PUBLIC_IP, family: 4 },
      { address: '10.0.0.7', family: 4 },
    ];
    const calls: Hop[] = [];
    await expect(safeFetch({ url: 'https://looks-public.example/', maxBytes: 1000, timeoutMs: 1000, resolve, request: async (hop) => (calls.push(hop), page(200)) }))
      .rejects.toThrow(/private or internal/);
    expect(calls).toHaveLength(0);
  });

  it('pins the connection to the vetted public address', async () => {
    const resolve = async (): Promise<ResolvedAddress[]> => [{ address: PUBLIC_IP, family: 4 }];
    const calls: Hop[] = [];
    const result = await safeFetch({ url: 'https://example.com/a', maxBytes: 1000, timeoutMs: 1000, resolve, request: async (hop) => (calls.push(hop), page(200)) });
    expect(calls.map((hop) => hop.address)).toEqual([PUBLIC_IP]);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/html');
  });

  it('re-checks every redirect target and refuses one that lands on a private address', async () => {
    const resolve = async (host: string): Promise<ResolvedAddress[]> => (host === 'example.com' ? [{ address: PUBLIC_IP, family: 4 }] : []);
    const calls: Hop[] = [];
    const request = async (hop: Hop): Promise<RawResponse> => {
      calls.push(hop);
      return calls.length === 1 ? page(302, { location: 'http://127.0.0.1/admin' }) : page(200);
    };
    await expect(safeFetch({ url: 'https://example.com/', maxBytes: 1000, timeoutMs: 1000, resolve, request })).rejects.toBeInstanceOf(UnsafeTargetError);
    expect(calls).toHaveLength(1);
  });

  it('follows a redirect to another public host and stops at the redirect cap', async () => {
    const resolve = async (): Promise<ResolvedAddress[]> => [{ address: PUBLIC_IP, family: 4 }];
    let hops = 0;
    const request = async (): Promise<RawResponse> => {
      hops += 1;
      return hops === 1 ? page(301, { location: '/next' }) : page(200);
    };
    const ok = await safeFetch({ url: 'https://example.com/', maxBytes: 1000, timeoutMs: 1000, resolve, request });
    expect(ok.finalUrl).toBe('https://example.com/next');

    hops = 0;
    await expect(safeFetch({ url: 'https://example.com/', maxBytes: 1000, timeoutMs: 1000, resolve, maxRedirects: 0, request: async () => page(302, { location: '/x' }) }))
      .rejects.toThrow(/Too many redirects/);
  });

  it('refuses non-http schemes', async () => {
    await expect(safeFetch({ url: 'file:///etc/passwd', maxBytes: 1000, timeoutMs: 1000 })).rejects.toThrow(/Only http and https/);
  });
});

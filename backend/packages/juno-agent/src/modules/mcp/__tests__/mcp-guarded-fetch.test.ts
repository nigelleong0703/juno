import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { createGuardedFetch, modelUrlRefused, type PinnedHop, type PinnedInit, type RawStreamResponse } from '../../tools/net/guardedFetch.js';
import { UnsafeTargetError, type ResolvedAddress } from '../../tools/net/safeFetch.js';

const PUBLIC_IP = '93.184.216.34';
const resolve = async (host: string): Promise<ResolvedAddress[]> => (host.endsWith('.example') ? [{ address: PUBLIC_IP, family: 4 }] : []);
const empty = (status: number, headers: Record<string, string> = {}): RawStreamResponse => ({ status, headers, stream: Readable.from([]) });

describe('guarded MCP fetch', () => {
  it('re-checks a redirect target and refuses one that lands on a loopback address', async () => {
    const hosts: string[] = [];
    const request = async (hop: PinnedHop): Promise<RawStreamResponse> => {
      hosts.push(hop.url.href);
      return empty(302, { location: 'http://127.0.0.1:9/mcp' });
    };
    await expect(createGuardedFetch({ resolve, request })('https://public.example/mcp')).rejects.toBeInstanceOf(UnsafeTargetError);
    expect(hosts).toEqual(['https://public.example/mcp']);
  });

  it('follows a cross-origin 307 with the method and body, and drops the bearer token', async () => {
    const seen: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
    const request = async (hop: PinnedHop, init: PinnedInit): Promise<RawStreamResponse> => {
      seen.push({ url: hop.url.href, method: init.method, headers: init.headers, body: init.body?.toString() });
      return hop.url.hostname === 'a.example' ? empty(307, { location: 'https://b.example/mcp' }) : empty(204);
    };
    const response = await createGuardedFetch({ resolve, request })('https://a.example/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
      body: '{"jsonrpc":"2.0"}',
    });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(seen.map((hop) => hop.url)).toEqual(['https://a.example/mcp', 'https://b.example/mcp']);
    expect(seen[0]?.headers.authorization).toBe('Bearer secret-token');
    expect(seen[1]).toMatchObject({ method: 'POST', body: '{"jsonrpc":"2.0"}' });
    expect(seen[1]?.headers.authorization).toBeUndefined();
  });

  it('lets only the hosted MCP paths through on a private address', async () => {
    const previous = process.env.BETTER_AUTH_URL;
    process.env.BETTER_AUTH_URL = 'http://127.0.0.1:8787';
    try {
      const reached: string[] = [];
      const request = async (hop: PinnedHop): Promise<RawStreamResponse> => {
        reached.push(hop.url.pathname);
        return hop.url.pathname === '/mcp/google/tasks/hop' ? empty(302, { location: 'http://127.0.0.1:8787/v1/agents' }) : empty(204);
      };
      const guarded = createGuardedFetch({ resolve, request });
      expect((await guarded('http://127.0.0.1:8787/mcp/google/tasks', { method: 'POST' })).status).toBe(204);
      expect((await guarded('http://127.0.0.1:8787/.well-known/oauth-protected-resource/mcp/google/tasks')).status).toBe(204);
      await expect(guarded('http://127.0.0.1:8787/v1/agents')).rejects.toBeInstanceOf(UnsafeTargetError);
      await expect(guarded('http://127.0.0.1:8788/mcp/google/tasks')).rejects.toBeInstanceOf(UnsafeTargetError);
      // A redirect out of the hosted path is checked again.
      await expect(guarded('http://127.0.0.1:8787/mcp/google/tasks/hop')).rejects.toBeInstanceOf(UnsafeTargetError);
      expect(reached).toEqual(['/mcp/google/tasks', '/.well-known/oauth-protected-resource/mcp/google/tasks', '/mcp/google/tasks/hop']);
    } finally {
      if (previous === undefined) delete process.env.BETTER_AUTH_URL; else process.env.BETTER_AUTH_URL = previous;
    }
  });

  it('refuses loopback and LAN model endpoints, and judges a redirect off a public host again', async () => {
    expect(modelUrlRefused('http://127.0.0.1:11434/v1')).toBe(true);
    expect(modelUrlRefused('http://localhost:1234/v1')).toBe(true);
    expect(modelUrlRefused('http://[::1]:11434/v1')).toBe(true);
    expect(modelUrlRefused('http://192.168.1.20:11434/v1')).toBe(true);
    expect(modelUrlRefused('ftp://127.0.0.1/v1')).toBe(true);
    expect(modelUrlRefused('https://api.example/v1')).toBe(false);

    const reached: string[] = [];
    const request = async (hop: PinnedHop): Promise<RawStreamResponse> => {
      reached.push(hop.url.host);
      return hop.url.hostname === 'api.example' ? empty(302, { location: 'http://127.0.0.1:9/hop' }) : empty(204);
    };
    const model = createGuardedFetch({ resolve, request });
    await expect(model('https://api.example/v1/models')).rejects.toBeInstanceOf(UnsafeTargetError);
    expect(reached).toEqual(['api.example']);
  });
});

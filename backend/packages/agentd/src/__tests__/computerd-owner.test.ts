import { describe, expect, it } from 'vitest';
import { createComputerdClient } from '../computerd.js';

const screen = {
  id: 's',
  ownerId: 'alice',
  computerId: 'vm',
  agentId: 'a',
  displayNo: 1,
  controller: 'agent',
  controlEpoch: 0,
  state: 'live',
  title: 'a',
  resolution: '1280x800',
  lastUsedAt: '2026-10-06T00:00:00Z',
};

function captureFetch() {
  const headers: Headers[] = [];
  const fetchImpl: typeof fetch = async (input: unknown, init?: RequestInit) => {
    headers.push(new Headers(init?.headers));
    const url = String(input);
    if (url.endsWith('/v1/computer')) {
      return new Response(JSON.stringify({ sandboxId: 'vm', template: 't', screens: [], metrics: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/screenshot')) {
      return new Response(JSON.stringify({ data: 'png', mimeType: 'image/png' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/v1/screens')) {
      return new Response(JSON.stringify({ items: [screen] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(screen), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { headers, fetchImpl };
}

describe('agentd computerd owner transport', () => {
  it('forwards the authenticated owner on every call including screenById', async () => {
    const seen = captureFetch();
    const client = createComputerdClient({
      baseUrl: 'http://computer',
      token: 'service',
      fetch: seen.fetchImpl,
      getOwnerId: () => 'alice',
    });
    const signal = AbortSignal.timeout(1000);
    await client.screenById('s', signal);
    await client.ensureScreen('a', signal);
    await client.computer(signal);
    await client.screens(signal);
    await client.takeOver('a', signal);
    await client.returnControl('a', signal);
    await client.screenshot({ agentId: 'a' }, signal);
    await client.pause(signal);
    await client.resume(signal);
    expect(seen.headers.length).toBe(9);
    for (const h of seen.headers) expect(h.get('x-owner-id')).toBe('alice');
  });

  it('keeps concurrent owners apart without shared state', async () => {
    const seen: Array<{ agent: string; owner: string | null }> = [];
    const fetchImpl: typeof fetch = async (_input: unknown, init?: RequestInit) => {
      void _input;
      const h = new Headers(init?.headers);
      seen.push({ agent: h.get('x-agent-id') ?? '', owner: h.get('x-owner-id') });
      return new Response(JSON.stringify(screen), { status: 200 });
    };
    const alice = createComputerdClient({
      baseUrl: 'http://computer',
      token: 'service',
      fetch: fetchImpl,
      getOwnerId: () => 'alice',
    });
    const bob = createComputerdClient({
      baseUrl: 'http://computer',
      token: 'service',
      fetch: fetchImpl,
      getOwnerId: () => 'bob',
    });
    await Promise.all([
      alice.ensureScreen('a1', AbortSignal.timeout(1000)),
      bob.ensureScreen('a2', AbortSignal.timeout(1000)),
    ]);
    expect(seen).toHaveLength(2);
    const byAgent = new Map(seen.map((s) => [s.agent, s.owner]));
    expect(byAgent.get('a1')).toBe('alice');
    expect(byAgent.get('a2')).toBe('bob');
  });
});

import { describe, expect, it } from 'vitest';
import { ComputerError } from '../../modules/tools/index.js';
import { loadConfig } from '../config.js';
import { createComputerdClient, selectComputerdClient } from '../infrastructure/computerd-executor/index.js';
import { createComputerOwnerResolver } from '../infrastructure/computerd-executor/select.js';

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

describe('runner computerd owner transport', () => {
  it('awaits an async resolver and forwards the owner on every call', async () => {
    const calls: Array<RequestInit | undefined> = [];
    const fetchImpl: typeof fetch = async (input: unknown, init?: RequestInit) => {
      calls.push(init);
      const url = String(input);
      const body = url.endsWith('/shell/run')
        ? { stdout: '', stderr: '', exitCode: 0 }
        : { data: 'png', width: 1, height: 1, displayNo: 1 };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = createComputerdClient({
      baseUrl: 'http://c.test',
      fetch: fetchImpl,
      getOwnerId: async (agentId: string) => `owner-of-${agentId}`,
    });
    const signal = AbortSignal.timeout(1000);
    await client.screenshot('agent-1', signal);
    await client.click('agent-1', { x: 1, y: 2 }, signal);
    await client.runShell('agent-1', { command: 'ls', timeoutMs: 1000 }, signal);
    expect(calls.length).toBe(3);
    for (const init of calls) expect(header(init, 'x-owner-id')).toBe('owner-of-agent-1');
  });

  it('keeps concurrent agents on their own owners', async () => {
    const seen = new Map<string, string | null>();
    const fetchImpl: typeof fetch = async (_input: unknown, init?: RequestInit) => {
      void _input;
      const h = new Headers(init?.headers);
      const agent = h.get('x-agent-id') ?? '';
      // Small delay so the two in-flight requests overlap.
      await new Promise((r) => setTimeout(r, 5));
      seen.set(agent, h.get('x-owner-id'));
      return new Response(JSON.stringify({ data: 'png', width: 1, height: 1, displayNo: 1 }), {
        status: 200,
      });
    };
    const owners: Record<string, string> = { a1: 'alice', a2: 'bob' };
    const client = createComputerdClient({
      baseUrl: 'http://c.test',
      fetch: fetchImpl,
      getOwnerId: async (agentId: string) => owners[agentId] ?? '',
    });
    await Promise.all([
      client.screenshot('a1', AbortSignal.timeout(1000)),
      client.screenshot('a2', AbortSignal.timeout(1000)),
    ]);
    expect(seen.get('a1')).toBe('alice');
    expect(seen.get('a2')).toBe('bob');
  });

  it('refuses when the resolver rejects or returns empty', async () => {
    const ok: typeof fetch = async () => new Response('{}', { status: 200 });
    const refusing = createComputerdClient({
      baseUrl: 'http://c.test',
      fetch: ok,
      getOwnerId: async () => {
        throw new ComputerError('not_allowed', 'unknown agent ghost');
      },
    });
    await expect(refusing.screenshot('ghost', AbortSignal.timeout(1000))).rejects.toMatchObject({
      code: 'not_allowed',
    });
    const empty = createComputerdClient({
      baseUrl: 'http://c.test',
      fetch: ok,
      getOwnerId: () => '',
    });
    await expect(empty.screenshot('ghost', AbortSignal.timeout(1000))).rejects.toMatchObject({
      code: 'not_allowed',
    });
  });

  it('select passes the resolver through', async () => {
    let resolved: string | undefined;
    const fetchImpl: typeof fetch = async (_input: unknown, init?: RequestInit) => {
      void _input;
      resolved = new Headers(init?.headers).get('x-owner-id') ?? undefined;
      return new Response(JSON.stringify({ data: 'png', width: 1, height: 1, displayNo: 1 }), {
        status: 200,
      });
    };
    const realFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchImpl;
    try {
      const client = selectComputerdClient({ COMPUTERD_URL: 'http://c.test' }, loadConfig({ COMPUTERD_TOKEN: 'cfg-token' }), () => {}, async () => 'alice');
      if (!client) throw new Error('expected client');
      await client.screenshot('agent-1', AbortSignal.timeout(1000));
      expect(resolved).toBe('alice');
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = realFetch;
    }
  });
});

describe('computer owner resolver', () => {
  it('prefers createdBy, then ownerId, and refuses an agent with no persisted owner (E41)', async () => {
    const docs: Record<string, unknown> = {
      a1: { id: 'a1', createdBy: 'alice', ownerId: 'other' },
      a2: { id: 'a2', ownerId: 'bob' },
      legacy: { id: 'legacy' },
    };
    const resolve = createComputerOwnerResolver(
      { getAgent: async (id: string) => docs[id] ?? null },
    );
    expect(await resolve('a1')).toBe('alice');
    expect(await resolve('a2')).toBe('bob');
    await expect(resolve('legacy')).rejects.toMatchObject({ code: 'not_allowed' });
    await expect(resolve('ghost')).rejects.toMatchObject({ code: 'not_allowed' });
  });
});

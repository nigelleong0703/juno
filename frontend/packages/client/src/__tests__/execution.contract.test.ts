/**
 * Secure input, task stop and resolved-request history: the mock and the HTTP client (over a fetch that serves
 * the mock the way the backend routes answer) must agree on shapes and error codes, and a submitted secret
 * must never come back in any response.
 */
import { createHttpClient } from '@agent-desktop/client/http';
import type { ApiClient } from '@agent-desktop/client';
import { describe, expect, it } from 'vitest';
import { createMockClient } from '@agent-desktop/test-fixtures';

const SECRET = '4242-secret-never-echo-91c';
const sealed = (text: string) => ({ epk: 'ZXBr', nonce: 'bm9uY2U=', ciphertext: text });

function mockBackendFetch(mock: ApiClient, seen: string[]): typeof fetch {
  const respond = (status: number, body: unknown): Response => {
    const text = JSON.stringify(body);
    seen.push(text);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  };
  return async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (parts[1] === 'requests' && parts[3] === 'secure-input') return respond(200, await mock.requests.submitSecureInput(parts[2]!, body));
      if (parts[1] === 'requests' && parts.length === 3) return respond(200, await mock.requests.get(parts[2]!));
      if (parts[1] === 'requests' && parts.length === 2) {
        const status = url.searchParams.get('status') ?? undefined;
        const limit = url.searchParams.get('limit');
        return respond(200, await mock.requests.list({ ...(status ? { status: status as 'resolved' } : {}), ...(limit ? { limit: Number(limit) } : {}) }));
      }
      if (parts[1] === 'tasks' && parts[3] === 'stop') return respond(200, await mock.tasks.stop(parts[2]!));
      if (parts[1] === 'tasks' && parts[3] === 'tree') return respond(200, await mock.tasks.tree(parts[2]!));
      if (parts[1] === 'tasks' && parts.length === 2) return respond(200, await mock.tasks.list({ ...(url.searchParams.get('status') ? { status: url.searchParams.get('status') as 'live' } : {}) }));
      if (parts[1] === 'agents' && parts[3] === 'tasks') return respond(200, await mock.agents.tasks(parts[2]!));
      if (parts[1] === 'computers' && parts[3] === 'screens') return respond(200, await mock.computers.allocateScreen(parts[2]!, body.agentId));
      if (parts[1] === 'computers' && parts.length === 2) return respond(200, await mock.computers.list());
      if (parts[1] === 'screens' && parts[3] === 'take-over') return respond(200, await mock.computers.takeOverScreen(parts[2]!));
      if (parts[1] === 'screens' && parts[3] === 'return-control') return respond(200, await mock.computers.returnControlScreen(parts[2]!));
      return respond(404, { error: { code: 'NOT_FOUND', message: 'no route' } });
    } catch (error) {
      const { status = 500, code = 'INTERNAL', message = String(error) } = error as { status?: number; code?: string; message?: string };
      return respond(status, { error: { code, message } });
    }
  };
}

async function codeOf(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  const error = (await promise.then(() => null, (e: unknown) => e)) as { status: number; code: string } | null;
  if (error === null) throw new Error('expected a rejection');
  return { status: error.status, code: error.code };
}

const variants: Array<{ name: string; make: (seen: string[]) => ApiClient }> = [
  { name: 'mock', make: () => createMockClient() },
  { name: 'http over mock backend', make: (seen) => createHttpClient({ baseUrl: 'http://api.test', fetch: mockBackendFetch(createMockClient(), seen) }) },
];

describe.each(variants)('execution contract: $name', ({ make }) => {
  it('secure input fills once, never echoes the value, and refuses wrong shapes', async () => {
    const seen: string[] = [];
    const client = make(seen);
    const id = 'req-juno-secure';
    expect(await codeOf(client.requests.submitSecureInput(id, { fields: { f1: sealed(SECRET) } }))).toEqual({ status: 400, code: 'VALIDATION' });

    const result = await client.requests.submitSecureInput(id, { fields: { f1: sealed(SECRET), f2: sealed('b'), f3: sealed('c') } });
    expect(result.request.status).toBe('approved');
    expect(result.fields.map((f) => f.status)).toEqual(['filled', 'filled', 'filled']);
    for (const value of [result, ...seen]) expect(JSON.stringify(value)).not.toContain(SECRET);

    expect(await codeOf(client.requests.submitSecureInput(id, { fields: { f1: sealed('x'), f2: sealed('y'), f3: sealed('z') } }))).toEqual({ status: 409, code: 'REQUEST_NOT_PENDING' });
    expect(await codeOf(client.requests.submitSecureInput('req-juno-email', { fields: { f1: sealed('x') } }))).toEqual({ status: 400, code: 'VALIDATION' });
  });

  it('asks the user to hand the screen back (409 USER_CONTROL) and keeps the request pending', async () => {
    const client = make([]);
    const computers = (await client.computers.list()).items;
    const screen = await client.computers.allocateScreen(computers[0]!.id, 'agent-juno');
    await client.computers.takeOverScreen(screen.id);
    const values = { f1: sealed(SECRET), f2: sealed('b'), f3: sealed('c') };
    expect(await codeOf(client.requests.submitSecureInput('req-juno-secure', { fields: values }))).toEqual({ status: 409, code: 'USER_CONTROL' });
    expect((await client.requests.get('req-juno-secure')).status).toBe('pending');
    await client.computers.returnControlScreen(screen.id);
    expect((await client.requests.submitSecureInput('req-juno-secure', { fields: values })).request.status).toBe('approved');
  });

  it('stops a running task, and 404s an unknown one', async () => {
    const client = make([]);
    const before = (await client.agents.tasks('agent-juno')).items;
    expect(before[0]?.status).toMatch(/running|waiting/);
    const stopped = await client.tasks.stop('task-juno-sub');
    expect(stopped).toMatchObject({ status: 'ended', outcome: 'cancelled', outcomeDetail: 'stopped_by_owner', resultLine: 'Stopped by you' });
    const tree = await client.tasks.tree('task-juno-wait');
    expect(tree.items.map((task) => task.id)).toContain('task-juno-sub');
    expect((await client.tasks.list({ status: 'live' })).items.every((task) => task.status !== 'ended')).toBe(true);
    expect(await codeOf(client.tasks.stop('task-missing'))).toEqual({ status: 404, code: 'NOT_FOUND' });
  });

  it('lists resolved requests newest first and without pending ones', async () => {
    const client = make([]);
    const { items } = await client.requests.list({ status: 'resolved' });
    expect(items.length).toBeGreaterThan(3);
    expect(items.every((r) => r.status !== 'pending')).toBe(true);
    const times = items.map((r) => r.resolvedAt ?? '');
    expect(times).toEqual([...times].sort().reverse());
  });
});

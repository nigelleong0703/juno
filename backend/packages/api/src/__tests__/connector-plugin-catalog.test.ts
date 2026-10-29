/** The gateway has no catalog of its own: it reads agentd's (built from the loaded plugins), caches it briefly, and shows a connection to a connector that is no longer offered as unavailable. */
import { describe, expect, it } from 'vitest';
import { createMemoryBlobStore, createMemoryStore } from '@agent-desktop/db';
import { createApiApp, type ApiAuth } from '../server.js';
import { createAgentdCatalog, type CatalogEntry } from '../modules/connector-catalog.js';
import { CONNECTOR_CATALOG } from './builtin-catalog.js';

const OWNER = 'owner-a';
const acme: CatalogEntry = { id: 'acme-crm', name: 'Acme CRM', icon: 'crm', description: 'Customer records.', category: 'productivity', url: 'https://mcp.acme.test/mcp' };
const gmail = CONNECTOR_CATALOG.find((entry) => entry.id === 'gmail');

/** A fake agentd: answers the catalog route with `items()` and records the calls. */
function fakeAgentd(items: () => CatalogEntry[] | 'down') {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
    const answer = items();
    return answer === 'down' ? new Response('no', { status: 503 }) : Response.json({ items: answer });
  };
  return { calls, fetchFn };
}

describe('createAgentdCatalog', () => {
  it('reads the catalog from agentd with the service bearer, caches it, refreshes after the ttl, and serves the last good one when agentd is down', async () => {
    let served: CatalogEntry[] | 'down' = [acme];
    const agentd = fakeAgentd(() => served);
    let now = 1_000;
    const read = createAgentdCatalog({ agentdUrl: 'http://agentd.test/', internalToken: 'service-token', fetchFn: agentd.fetchFn, ttlMs: 10_000, now: () => now });
    expect((await read()).map((entry) => entry.id)).toEqual(['acme-crm']);
    expect(agentd.calls).toEqual([{ url: 'http://agentd.test/internal/connector-catalog', authorization: 'Bearer service-token' }]);
    served = [];
    now += 9_000;
    expect((await read()).map((entry) => entry.id)).toEqual(['acme-crm']);
    expect(agentd.calls).toHaveLength(1);
    now += 2_000;
    expect(await read()).toEqual([]);
    served = 'down';
    now += 20_000;
    expect(await read()).toEqual([]);
    expect(agentd.calls).toHaveLength(3);
  });

  it('fails with a 503 when agentd has never answered, rather than showing an empty store', async () => {
    const read = createAgentdCatalog({ agentdUrl: 'http://agentd.test', internalToken: 't', fetchFn: fakeAgentd(() => 'down').fetchFn });
    await expect(read()).rejects.toMatchObject({ status: 503, code: 'CONNECTOR_CATALOG_UNAVAILABLE' });
  });

  it('adds the scopes only the gateway knows to a hosted Google entry', async () => {
    const hosted = CONNECTOR_CATALOG.find((entry) => entry.id === 'google-calendar');
    if (hosted === undefined) throw new Error('missing built-in google-calendar');
    const { scopes: _gatewayScopes, ...fromAgentd } = hosted;
    const read = createAgentdCatalog({ agentdUrl: 'http://agentd.test', internalToken: 't', fetchFn: fakeAgentd(() => [fromAgentd]).fetchFn });
    expect((await read())[0]?.scopes).toEqual(hosted.scopes);
    expect(hosted.scopes?.length).toBeGreaterThan(0);
  });
});

function testAuth(): ApiAuth {
  return {
    info: { mode: 'account', providers: ['credential'] },
    handle: async () => new Response('auth', { status: 200 }),
    resolve: async () => ({ ownerId: OWNER }),
  };
}

describe('app routes over agentd\'s catalog', () => {
  it('an app agentd does not serve is not the gateway\'s to add (the request goes on to agentd), and an account of one that is no longer offered can still be removed', async () => {
    if (gmail === undefined) throw new Error('missing built-in gmail');
    const agentd = fakeAgentd(() => [acme]);
    const store = createMemoryStore();
    await store.forOwner?.(OWNER)?.put('connections', {
      id: 'con-gmail', kind: 'mcp', name: 'Gmail', ownerId: OWNER, transport: 'http', catalogId: 'gmail',
      status: 'connected', enabled: true, endpoint: 'https://gw.test/mcp/google/gmail', connectedAt: '2026-10-20T00:00:00.000Z',
    } as never);
    const app = createApiApp({
      auth: testAuth(), agentdUrl: 'http://agentd.test', internalToken: 'service-token', fetch: agentd.fetchFn,
      store, blobs: createMemoryBlobStore(), publicUrl: 'https://gw.test', mcpOAuth: { returnUrl: 'http://web.test/connectors', env: {} },
    });
    const call = (path: string, method = 'GET') => Promise.resolve(app.request(path, { method, headers: { authorization: 'Bearer a' } }));

    // Not in the catalog agentd serves: the gateway does not add it, so the call reaches agentd (here a fake that answers the catalog).
    agentd.calls.length = 0;
    await call('/v1/apps/google-calendar/install', 'POST');
    expect(agentd.calls.map((entry) => entry.url)).toContain('http://agentd.test/v1/apps/google-calendar/install');

    // The owner's account of the connector that is gone is theirs to remove: the gateway does it (no call to agentd for it).
    agentd.calls.length = 0;
    const dropped = await call('/v1/apps/gmail/installations/con-gmail', 'DELETE');
    expect(dropped.status).toBe(204);
    expect(agentd.calls.some((entry) => entry.url.includes('/installations/'))).toBe(false);
    expect(await store.forOwner?.(OWNER)?.get('connections', 'con-gmail')).toMatchObject({ enabled: false, status: 'disconnected' });
    // An account of another app under this id is not found.
    expect((await call('/v1/apps/acme-crm/installations/con-gmail', 'DELETE')).status).toBe(404);
  });
});

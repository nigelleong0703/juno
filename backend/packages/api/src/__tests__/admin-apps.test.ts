/**
 * The operator's path to the app catalog (BACKEND 10.18): `/admin/v1/apps` on the public API, behind ADMIN_TOKEN, relayed to agentd with the
 * service bearer. It is off without a token, refuses every other credential, passes agentd's answers through, and drops the catalog the
 * gateway cached so a change shows at once.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryBlobStore, createMemoryStore } from '@agent-desktop/db';
import { createApiApp, type ApiAuth } from '../server.js';
import { createAgentdCatalog, type CatalogEntry } from '../modules/connector-catalog.js';

const OWNER = 'owner-a';
const ADMIN = 'admin-secret';
const SERVICE = 'service-token';
const acme: CatalogEntry = { id: 'acme-crm', name: 'Acme CRM', icon: 'crm', description: 'Customer records.', category: 'productivity', url: 'https://mcp.acme.test/mcp' };
const zeta: CatalogEntry = { ...acme, id: 'zeta', name: 'Zeta' };

interface Call { method: string; url: string; authorization: string | null; ownerId: string | null; body: string }

/** A fake agentd: the catalog route, and the admin routes, which answer with whatever `admin` says. */
function fakeAgentd(admin: (call: Call) => Response = () => Response.json({ ok: true })) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const call: Call = { method: init?.method ?? 'GET', url: String(input), authorization: headers.get('authorization'), ownerId: headers.get('x-owner-id'), body: typeof init?.body === 'string' ? init.body : '' };
    calls.push(call);
    if (call.url.endsWith('/internal/connector-catalog')) return Response.json({ items: [acme], held: [acme, zeta] });
    if (call.url.includes('/v1/admin/apps')) return admin(call);
    return Response.json({});
  };
  return { calls, fetchFn };
}

function appWith(agentd: ReturnType<typeof fakeAgentd>, adminToken: string | undefined) {
  const auth: ApiAuth = { info: { mode: 'account', providers: ['credential'] }, handle: async () => new Response('auth'), resolve: async () => ({ ownerId: OWNER }) };
  return createApiApp({
    auth, agentdUrl: 'http://agentd.test', internalToken: SERVICE, fetch: agentd.fetchFn, ...(adminToken === undefined ? {} : { adminToken }),
    store: createMemoryStore(), blobs: createMemoryBlobStore(), publicUrl: 'https://gw.test', mcpOAuth: { returnUrl: 'http://web.test/connectors', env: {} },
  });
}
const as = (app: ReturnType<typeof appWith>, token: string | undefined, path: string, init: { method?: string; body?: unknown } = {}) => Promise.resolve(app.request(path, {
  method: init.method ?? 'GET',
  headers: { ...(token === undefined ? {} : { authorization: 'Bearer ' + token }), ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
}));

describe('/admin/v1/apps', () => {
  it('is not there without an ADMIN_TOKEN', async () => {
    const agentd = fakeAgentd();
    const app = appWith(agentd, undefined);
    expect((await as(app, ADMIN, '/admin/v1/apps')).status).toBe(404);
    expect((await as(appWith(agentd, ''), '', '/admin/v1/apps', { method: 'POST', body: {} })).status).toBe(404);
    expect(agentd.calls).toHaveLength(0);
  });

  it('refuses a missing token, a wrong one, the service bearer and a user session, and never reaches agentd', async () => {
    const agentd = fakeAgentd();
    const app = appWith(agentd, ADMIN);
    for (const token of [undefined, 'nope', SERVICE, 'Bearer a', ADMIN + 'x', '']) {
      expect((await as(app, token, '/admin/v1/apps')).status).toBe(401);
    }
    expect((await as(app, SERVICE, '/admin/v1/apps/gmail', { method: 'PATCH', body: { blurb: 'x' } })).status).toBe(401);
    expect((await as(app, undefined, '/admin/v1/apps/gmail/retire', { method: 'POST' })).status).toBe(401);
    expect(agentd.calls).toHaveLength(0);
  });

  it('relays the four routes to agentd with the service bearer and no owner, and passes its status and body through', async () => {
    const agentd = fakeAgentd((call) => call.method === 'POST' && call.url.endsWith('/v1/admin/apps')
      ? Response.json({ error: { code: 'APP_EXISTS', message: 'exists' } }, { status: 409 })
      : Response.json({ forwarded: call.method + ' ' + new URL(call.url).pathname }));
    const app = appWith(agentd, ADMIN);
    expect(await (await as(app, ADMIN, '/admin/v1/apps')).json()).toEqual({ forwarded: 'GET /v1/admin/apps' });
    const refused = await as(app, ADMIN, '/admin/v1/apps', { method: 'POST', body: { id: 'gmail' } });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: 'APP_EXISTS' } });
    expect(await (await as(app, ADMIN, '/admin/v1/apps/gmail', { method: 'PATCH', body: { blurb: 'Mail.' } })).json()).toEqual({ forwarded: 'PATCH /v1/admin/apps/gmail' });
    expect(await (await as(app, ADMIN, '/admin/v1/apps/gmail/retire', { method: 'POST' })).json()).toEqual({ forwarded: 'POST /v1/admin/apps/gmail/retire' });
    expect(agentd.calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([['GET', '/v1/admin/apps'], ['POST', '/v1/admin/apps'], ['PATCH', '/v1/admin/apps/gmail'], ['POST', '/v1/admin/apps/gmail/retire']]);
    // The admin token never leaves the gateway; agentd gets the service bearer and no owner.
    expect(agentd.calls.every((call) => call.authorization === 'Bearer ' + SERVICE && call.ownerId === null)).toBe(true);
    expect(agentd.calls[1]?.body).toBe(JSON.stringify({ id: 'gmail' }));
    expect(agentd.calls[2]?.body).toBe(JSON.stringify({ blurb: 'Mail.' }));
  });

  it('a write that went through drops the catalog the gateway cached; one agentd refused, and a read, do not', async () => {
    let refuse = false;
    const agentd = fakeAgentd(() => (refuse ? Response.json({ error: { code: 'INVALID_APP', message: 'no' } }, { status: 400 }) : Response.json({ ok: true })));
    const app = appWith(agentd, ADMIN);
    const catalogReads = () => agentd.calls.filter((call) => call.url.endsWith('/internal/connector-catalog')).length;
    // An install the gateway does not know goes on to agentd, but first the gateway looks the app up in its catalog.
    const touch = () => as(app, 'a', '/v1/apps/not-here/install', { method: 'POST' });
    await touch();
    await touch();
    expect(catalogReads()).toBe(1);
    await as(app, ADMIN, '/admin/v1/apps');
    await touch();
    expect(catalogReads()).toBe(1);
    refuse = true;
    await as(app, ADMIN, '/admin/v1/apps/acme-crm', { method: 'PATCH', body: { blurb: 'x' } });
    await touch();
    expect(catalogReads()).toBe(1);
    refuse = false;
    await as(app, ADMIN, '/admin/v1/apps/acme-crm', { method: 'PATCH', body: { blurb: 'x' } });
    await touch();
    expect(catalogReads()).toBe(2);
  });

  it('answers 502 when agentd cannot be reached', async () => {
    const down: typeof fetch = async () => { throw new Error('connection refused'); };
    const app = appWith({ calls: [], fetchFn: down }, ADMIN);
    const response = await as(app, ADMIN, '/admin/v1/apps');
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'ADMIN_UNAVAILABLE' } });
  });
});

describe('the catalog the gateway reads', () => {
  it('offers the listed apps for adding and also knows the hidden ones; invalidate reads agentd again', async () => {
    const agentd = fakeAgentd();
    const read = createAgentdCatalog({ agentdUrl: 'http://agentd.test', internalToken: SERVICE, fetchFn: agentd.fetchFn });
    expect((await read()).map((entry) => entry.id)).toEqual(['acme-crm']);
    expect((await read.held()).map((entry) => entry.id)).toEqual(['acme-crm', 'zeta']);
    expect(agentd.calls).toHaveLength(1);
    read.invalidate();
    await read();
    expect(agentd.calls).toHaveLength(2);
  });
});

/**
 * Apps that need no sign-in (BACKEND 10.15; today Google Maps on the deployment key) are connected by default
 * for every owner: whichever comes first, the Apps page (agentd) or the agent's tools, writes the owner's row; one row
 * per owner; removing it sticks; adding the app again turns it back on. Maps traffic goes to a stub standing in for mapstools.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryBlobStore, createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import { createMcpManager, mcpToolsForAgent } from '@agent-desktop/contracts/mcp';
import { installAppResponseSchema } from '@agent-desktop/public-contracts';
import { createApiApp } from '../server.js';
import { CONNECTOR_CATALOG } from './builtin-catalog.js';

const KEY = 'test-maps-key';
const MAPS = 'https://mapstools.googleapis.com/mcp';

describe('keyless connectors are connected by default', () => {
  let store: Store;
  let app: ReturnType<typeof createApiApp>;
  const keysSeen: (string | null)[] = [];
  const previous = { secrets: process.env.SECRETS_KEY, maps: process.env.GOOGLE_MAPS_API_KEY };

  /** Stands in for mapstools: open initialize and tools/list, like the real server. */
  const mapsStub: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== MAPS) throw new Error('unexpected request to ' + url);
    keysSeen.push(new Headers(init?.headers).get('x-goog-api-key'));
    const message = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'StatelessServer', version: '1' } }
      : { tools: [{ name: 'search_places', description: 'Find places', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] };
    return Response.json({ jsonrpc: '2.0', id: message.id, result });
  };

  beforeAll(async () => {
    process.env.SECRETS_KEY = randomBytes(32).toString('base64');
    process.env.GOOGLE_MAPS_API_KEY = KEY;
    store = createMemoryStore();
    for (const owner of ['owner-a', 'owner-b']) await store.forOwner?.(owner)?.put('agents', { id: 'agent-' + owner, name: 'Agent', pluginIds: [], ownerId: owner } as never);
    app = createApiApp({
      auth: { info: { mode: 'account', providers: ['credential'] }, handle: async () => new Response(null), resolve: async (request) => ({ ownerId: request.headers.get('authorization')?.slice('Bearer '.length) ?? '' }) },
      agentdUrl: 'http://127.0.0.1:1', internalToken: 'service-token', fetch: async () => Response.json({ items: [] }),
      store, blobs: createMemoryBlobStore(), publicUrl: 'https://api.test', connectorCatalog: CONNECTOR_CATALOG, mcpOAuth: { returnUrl: 'http://web.test/connectors', env: { GOOGLE_MAPS_API_KEY: KEY }, fetch: mapsStub },
    });
  });

  afterAll(() => {
    for (const [name, value] of [['SECRETS_KEY', previous.secrets], ['GOOGLE_MAPS_API_KEY', previous.maps]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  const request = (owner: string, path: string, method = 'GET') => Promise.resolve(app.request(path, { method, headers: { Authorization: 'Bearer ' + owner } }));
  const agentTools = async (owner: string) => {
    const scoped = store.forOwner?.(owner);
    if (!scoped) throw new Error('missing forOwner');
    return (await mcpToolsForAgent(createMcpManager({ fetchImpl: mapsStub }), scoped, 'agent-' + owner, new Set())).map((tool) => tool.name);
  };
  const mapsRows = async (owner: string) => (await store.forOwner?.(owner)?.list('connections', { limit: 200 }))?.items.filter((c) => c.catalogId === 'google-maps') ?? [];

  it("the agent's tools write the row without any sign-in, and removing the app sticks until it is added again", async () => {
    expect(await agentTools('owner-a')).toContainEqual(expect.stringContaining('search_places'));
    expect(keysSeen.at(-1)).toBe(KEY);
    const [row] = await mapsRows('owner-a');
    expect(row).toMatchObject({ status: 'connected', enabled: true });

    expect((await request('owner-a', '/v1/apps/google-maps/installations/' + (row?.id ?? ''), 'DELETE')).status).toBe(204);
    expect(await agentTools('owner-a')).toEqual([]);
    expect(await mapsRows('owner-a')).toHaveLength(1);

    const back = installAppResponseSchema.parse(await (await request('owner-a', '/v1/apps/google-maps/install', 'POST')).json());
    expect(back).toMatchObject({ openUrl: null, installation: { appId: 'google-maps', status: 'connected' } });
    expect(await mapsRows('owner-a')).toHaveLength(1);
    expect(await agentTools('owner-a')).toContainEqual(expect.stringContaining('search_places'));
  });

  it('another owner gets their own single row the same way', async () => {
    expect(await agentTools('owner-b')).toContainEqual(expect.stringContaining('search_places'));
    expect(await mapsRows('owner-b')).toHaveLength(1);
  });
});

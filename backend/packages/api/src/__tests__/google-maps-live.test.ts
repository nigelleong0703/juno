/**
 * Google Maps against the real Maps Grounding Lite server with this deployment's key (BACKEND 10.15). Runs only
 * when GOOGLE_MAPS_API_KEY is set: it is connected by default, connect needs no sign-in, the agent's call carries the key, and nothing the
 * gateway returns contains it.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryBlobStore, createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import { createMcpManager, mcpToolsForAgent } from '@agent-desktop/contracts/mcp';
import { installAppResponseSchema } from '@agent-desktop/public-contracts';
import { createApiApp } from '../server.js';
import { CONNECTOR_CATALOG } from './builtin-catalog.js';

const KEY = process.env.GOOGLE_MAPS_API_KEY ?? '';
const OWNER = 'owner-a';
const AGENT = 'agent-a';

describe.skipIf(KEY === '')('Google Maps with the deployment key (live)', () => {
  let store: Store;
  let app: ReturnType<typeof createApiApp>;
  const previousKey = process.env.SECRETS_KEY;

  beforeAll(async () => {
    process.env.SECRETS_KEY = randomBytes(32).toString('base64');
    store = createMemoryStore();
    await store.forOwner?.(OWNER)?.put('agents', { id: AGENT, name: 'Agent A', pluginIds: [], ownerId: OWNER } as never);
    app = createApiApp({
      auth: { info: { mode: 'account', providers: ['credential'] }, handle: async () => new Response(null), resolve: async (request) => (request.headers.get('authorization') === 'Bearer a' ? { ownerId: OWNER } : null) },
      agentdUrl: 'http://127.0.0.1:1', internalToken: 'service-token', fetch: async () => Response.json({ items: [] }),
      store, blobs: createMemoryBlobStore(), publicUrl: 'https://api.test', connectorCatalog: CONNECTOR_CATALOG, mcpOAuth: { returnUrl: 'http://web.test/connectors', env: { GOOGLE_MAPS_API_KEY: KEY } },
    });
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env.SECRETS_KEY; else process.env.SECRETS_KEY = previousKey;
  });

  it('connects without a sign-in and the agent finds a real place', async () => {
    const request = (path: string, method = 'GET') => Promise.resolve(app.request(path, { method, headers: { Authorization: 'Bearer a' } }));
    // Adding it needs no sign-in: the account is connected at once (and the agent's tools would have added it by default).
    const started = await (await request('/v1/apps/google-maps/install', 'POST')).text();
    const { installation, openUrl } = installAppResponseSchema.parse(JSON.parse(started));
    expect(openUrl).toBeNull();
    expect(installation?.status).toBe('connected');

    const scoped = store.forOwner?.(OWNER);
    if (!scoped) throw new Error('missing forOwner');
    const manager = createMcpManager();
    const names = (await mcpToolsForAgent(manager, scoped, AGENT, new Set())).map((tool) => tool.name);
    expect(names).toContainEqual(expect.stringContaining('search_places'));
    const result = JSON.stringify(await manager.callTool({ ownerId: OWNER, store: scoped, agentId: AGENT, connectionId: installation?.id ?? '', toolName: 'search_places', args: { text_query: 'Marina Bay Sands Singapore' } }));
    expect(result).toMatch(/Marina Bay Sands/i);
    expect(result).not.toContain('isError":true');

    for (const body of [started, JSON.stringify(await scoped.get('connections', installation?.id ?? ''))]) expect(body).not.toContain(KEY);
  }, 60_000);
});

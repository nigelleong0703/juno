/**
 * Hevy connector (BACKEND 10.15): no OAuth, the owner pastes their own Hevy API key. The key is sealed on the
 * owner's connection row, goes to the gateway's hosted /mcp/hevy as the `api-key` header and from there to Hevy; it
 * is never returned or logged. Hevy itself is a fake fetch; the agent reaches the gateway in-process.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMemoryBlobStore, createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import { createMcpManager, mcpToolsForAgent } from '@agent-desktop/contracts/mcp';
import { installAppResponseSchema } from '@agent-desktop/public-contracts';
import { createApiApp } from '../server.js';
import { CONNECTOR_CATALOG } from './builtin-catalog.js';

const OWNER = 'owner-a';
const AGENT = 'agent-a';
const PUBLIC_URL = 'https://api.test';
const KEY = '8c1f6a52-1b7e-4a53-9d0e-5f1f6f1a2b3c';
const HEVY = 'https://hevy.test/v1';

interface HevyCall { method: string; path: string; key: string | null; body?: unknown }

describe('Hevy connector', () => {
  let store: Store;
  let app: ReturnType<typeof createApiApp>;
  let manager: ReturnType<typeof createMcpManager>;
  const calls: HevyCall[] = [];
  let hevyStatus = 200;
  const logged: string[] = [];
  const previous = process.env.SECRETS_KEY;

  const templates = Array.from({ length: 130 }, (_, index) => ({ id: 'T' + String(index), title: index === 120 ? 'Bench Press (Barbell)' : 'Exercise ' + String(index), type: 'weight_reps', primary_muscle_group: 'chest', is_custom: false }));
  const workout = { id: 'w1', title: 'Push day', description: null, start_time: '2026-10-18T07:00:00Z', end_time: '2026-10-18T08:00:00Z', updated_at: 'x', exercises: [{ index: 0, title: 'Bench Press (Barbell)', exercise_template_id: 'T120', notes: '', sets: [{ index: 0, type: 'normal', weight_kg: 80, reps: 8, rpe: null }] }] };

  /** A fake Hevy: records the key header and answers the few endpoints the tools use. */
  const fakeHevy: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const call: HevyCall = { method, path: url.pathname.replace('/v1', '') + url.search, key: new Headers(init?.headers).get('api-key'), ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) };
    calls.push(call);
    if (hevyStatus !== 200) return new Response('nope', { status: hevyStatus });
    if (url.pathname === '/v1/workouts/count') return Response.json({ workout_count: 42 });
    if (url.pathname === '/v1/workouts' && method === 'POST') return Response.json({ workout: [workout] }, { status: 201 });
    if (url.pathname === '/v1/workouts') return Response.json({ page: 1, page_count: 5, workouts: [workout] });
    if (url.pathname === '/v1/exercise_templates') {
      const page = Number(url.searchParams.get('page'));
      return Response.json({ page, page_count: 2, exercise_templates: templates.slice((page - 1) * 100, page * 100) });
    }
    return Response.json({ error: 'unexpected ' + url.pathname }, { status: 404 });
  };

  beforeAll(() => {
    process.env.SECRETS_KEY = randomBytes(32).toString('base64');
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    store = createMemoryStore();
    void store.forOwner?.(OWNER)?.put('agents', { id: AGENT, name: 'Agent', pluginIds: [], ownerId: OWNER } as never);
    const gateway: typeof fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(PUBLIC_URL)) throw new Error('unexpected request to ' + url);
      return Promise.resolve(app.request(url, init));
    };
    manager = createMcpManager({ fetchImpl: gateway });
    app = createApiApp({
      auth: { info: { mode: 'account', providers: ['credential'] }, handle: async () => new Response(null), resolve: async () => ({ ownerId: OWNER }) },
      agentdUrl: 'http://127.0.0.1:1', internalToken: 'service-token', fetch: async () => Response.json({ items: [] }),
      store, blobs: createMemoryBlobStore(), publicUrl: PUBLIC_URL, connectorCatalog: CONNECTOR_CATALOG, hevyMcp: { fetchImpl: fakeHevy, apiBase: HEVY },
      mcpOAuth: { returnUrl: 'http://web.test/connectors', env: {}, fetch: gateway },
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();
    if (previous === undefined) delete process.env.SECRETS_KEY; else process.env.SECRETS_KEY = previous;
  });

  const api = (path: string, method = 'GET', body?: unknown): Promise<Response> =>
    Promise.resolve(app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const scoped = (): Store => {
    const owned = store.forOwner?.(OWNER);
    if (!owned) throw new Error('missing forOwner');
    return owned;
  };
  const hevyRow = async () => (await scoped().list('connections', { limit: 10 })).items.find((item) => item.catalogId === 'hevy');
  /** What the agent may do with Hevy: its Actions policy (the Apps page sets it through agentd). */
  const actions = (actionsPolicy: 'ask' | 'allow' | 'off') => scoped().put('agentApps', { id: AGENT + ':hevy', ownerId: OWNER, agentId: AGENT, appId: 'hevy', enabled: true, actionsPolicy, updatedAt: new Date().toISOString() });
  const toolNames = async () => (await mcpToolsForAgent(manager, scoped(), AGENT, new Set())).map((tool) => tool.name);
  const rpc = async (headers: Record<string, string>, method: string, params?: unknown) =>
    (await (await app.request('/mcp/hevy', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result?: { tools?: Array<{ name: string; title: string; annotations: Record<string, unknown> }>; content?: Array<{ text: string }>; isError?: boolean } };
  const run = async (name: string, args: Record<string, unknown>) => {
    const connection = (await scoped().list('connections', { limit: 10 })).items.find((item) => item.catalogId === 'hevy');
    if (!connection) throw new Error('not connected');
    return manager.callTool({ ownerId: OWNER, store: scoped(), agentId: AGENT, connectionId: connection.id, toolName: name, args });
  };
  const textOf = (result: { text: string }): string => result.text;

  it('asks for an API key: adding Hevy without one is refused', async () => {
    expect(await hevyRow()).toBeUndefined();
    for (const body of [undefined, {}, { userConfig: {} }, { userConfig: { api_key: '   ' } }]) {
      const refused = await api('/v1/apps/hevy/install', 'POST', body);
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: 'CONNECTOR_CONFIG_REQUIRED', message: expect.stringContaining('Hevy API key') });
    }
    // A value the app does not declare, or of the wrong type, is refused by name; the old `apiKey` body is not a field any more.
    expect(((await (await api('/v1/apps/hevy/install', 'POST', { userConfig: { api_key: KEY, other: 'x' } })).json()) as { error: { code: string } }).error.code).toBe('CONNECTOR_CONFIG_UNKNOWN');
    expect(((await (await api('/v1/apps/hevy/install', 'POST', { userConfig: { api_key: 42 } })).json()) as { error: { code: string } }).error.code).toBe('CONNECTOR_CONFIG_INVALID');
    expect((await api('/v1/apps/hevy/install', 'POST', { apiKey: KEY })).status).toBe(400);
    expect(await hevyRow()).toBeUndefined();
  });

  it('a key Hevy rejects is not connected: the read-only probe fails, nothing is stored, and the answer says why without the key', async () => {
    hevyStatus = 401;
    calls.length = 0;
    const refused = await api('/v1/apps/hevy/install', 'POST', { userConfig: { api_key: KEY } });
    hevyStatus = 200;
    const text = await refused.text();
    expect(refused.status).toBe(400);
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'CONNECTOR_PROBE_FAILED', message: expect.stringMatching(/Could not connect Hevy: .*rejected the API key.*Check the value/) } });
    expect(text).not.toContain(KEY);
    // The probe was the catalog's read-only call, with the key in the header; nothing else touched Hevy and no row exists.
    expect(calls).toEqual([{ method: 'GET', path: '/workouts/count', key: KEY }]);
    expect(await hevyRow()).toBeUndefined();
  });

  it('Adding Hevy with the key seals it on the connection and never returns it', async () => {
    const response = await api('/v1/apps/hevy/install', 'POST', { userConfig: { api_key: ' ' + KEY + ' ' } });
    const text = await response.text();
    expect(installAppResponseSchema.parse(JSON.parse(text))).toMatchObject({ appId: 'hevy', openUrl: null, installation: { appId: 'hevy', status: 'connected' } });
    expect(text).not.toContain(KEY);
    const row = await hevyRow();
    expect(JSON.stringify(row)).not.toContain(KEY);
    // The header the key goes in, resolved from `${user_config.api_key}`, and the value as the owner gave it: both sealed.
    expect(Reflect.get(row ?? {}, 'headers')).toEqual({ 'api-key': expect.stringMatching(/^enc:v1:/) });
    expect(Reflect.get(row ?? {}, 'userConfig')).toEqual({ api_key: expect.stringMatching(/^enc:v1:/) });
  });

  it('typing a bad key over a working one is refused and leaves the working connection as it was', async () => {
    const before = await hevyRow();
    hevyStatus = 401;
    const refused = await api('/v1/apps/hevy/install', 'POST', { userConfig: { api_key: 'wrong-key' } });
    hevyStatus = 200;
    expect(refused.status).toBe(400);
    const after = await hevyRow();
    expect(after).toMatchObject({ id: before?.id, status: 'connected', enabled: true });
    expect(Reflect.get(after ?? {}, 'userConfig')).toEqual(Reflect.get(before ?? {}, 'userConfig'));
  });

  it('Actions off: read tools shaped for the model, the key reaches Hevy as the api-key header', async () => {
    await actions('off');
    expect(await toolNames()).toEqual(['hevy_list_workouts', 'hevy_get_workout', 'hevy_workout_count', 'hevy_list_routines', 'hevy_list_exercise_templates']);
    calls.length = 0;
    const result = textOf(await run('list_workouts', { pageSize: 50 }));
    expect(calls).toEqual([{ method: 'GET', path: '/workouts?page=1&pageSize=10', key: KEY }]);
    expect(result).toContain('Push day');
    expect(result).toContain('"weight_kg":80');
    expect(result).not.toContain('updated_at');
    expect(result).not.toContain(KEY);
    expect(textOf(await run('workout_count', {}))).toContain('42');
  });

  it('searches exercises by name across pages (Hevy has no name filter)', async () => {
    calls.length = 0;
    const result = textOf(await run('list_exercise_templates', { search: 'bench press' }));
    expect(result).toContain('Bench Press (Barbell)');
    expect(calls.map((call) => call.path)).toEqual(['/exercise_templates?page=1&pageSize=100', '/exercise_templates?page=2&pageSize=100']);
  });

  it('create_workout is a write: hidden when Actions is off, offered (asking first) once it is on, posts the Hevy body', async () => {
    expect(await toolNames()).not.toContain('hevy_create_workout');
    await actions('ask');
    expect(await toolNames()).toContain('hevy_create_workout');
    calls.length = 0;
    const result = textOf(await run('create_workout', {
      title: 'Leg day', start_time: '2026-10-19T07:00:00Z', end_time: '2026-10-19T08:00:00Z',
      exercises: [{ exercise_template_id: 'T1', sets: [{ weight_kg: 100, reps: 5 }, { type: 'warmup', reps: 10 }] }],
    }));
    expect(calls).toEqual([{
      method: 'POST', path: '/workouts', key: KEY,
      body: { workout: {
        title: 'Leg day', description: null, start_time: '2026-10-19T07:00:00Z', end_time: '2026-10-19T08:00:00Z', is_private: false,
        exercises: [{ exercise_template_id: 'T1', superset_id: null, notes: null, sets: [
          { type: 'normal', weight_kg: 100, reps: 5, distance_meters: null, duration_seconds: null, rpe: null },
          { type: 'warmup', weight_kg: null, reps: 10, distance_meters: null, duration_seconds: null, rpe: null },
        ] }],
      } },
    }]);
    expect(result).toContain('Push day');
    expect(textOf(await run('create_workout', { title: 'x' }))).toContain('needs title');
  });

  it('every tool has a title; reads are readOnlyHint, the write is destructiveHint false', async () => {
    const tools = (await rpc({}, 'tools/list')).result?.tools ?? [];
    expect(tools.map((tool) => tool.name)).toHaveLength(6);
    for (const tool of tools) {
      expect(tool.title).not.toBe('');
      expect(tool.annotations.title).toBe(tool.title);
      expect(tool.annotations.readOnlyHint).toBe(tool.name !== 'create_workout');
    }
    expect(tools.find((tool) => tool.name === 'create_workout')?.annotations.destructiveHint).toBe(false);
  });

  it('no key is a clear tool error (not a 401), and a key Hevy rejects says so without repeating it', async () => {
    const missing = await app.request('/mcp/hevy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workout_count', arguments: {} } }) });
    expect(missing.status).toBe(200);
    const body = (await missing.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toMatch(/connect Hevy with your Hevy API key/);

    calls.length = 0;
    hevyStatus = 401;
    const rejected = await rpc({ 'api-key': KEY }, 'tools/call', { name: 'workout_count', arguments: {} });
    hevyStatus = 200;
    expect(rejected.result?.isError).toBe(true);
    expect(rejected.result?.content?.[0]?.text).toMatch(/rejected the API key/);
    expect(JSON.stringify(rejected)).not.toContain(KEY);
  });

  it('disconnect drops the key and the tools; the key never reached a log', async () => {
    const id = (await hevyRow())?.id ?? '';
    expect((await api('/v1/apps/hevy/installations/' + id, 'DELETE')).status).toBe(204);
    const row = await hevyRow();
    expect(row?.status).toBe('disconnected');
    expect(Reflect.get(row ?? {}, 'headers') ?? null).toBeNull();
    expect(Reflect.get(row ?? {}, 'userConfig') ?? null).toBeNull();
    expect(await toolNames()).toEqual([]);
    expect(logged.join('\n')).not.toContain(KEY);
  });
});

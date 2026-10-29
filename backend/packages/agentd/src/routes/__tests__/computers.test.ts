/**
 * Public screen API behaviour: the id the app sees and the write-vs-watch rule for stream tickets.
 * Both were reported as real defects, so they are pinned here against a fake computerd.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { type Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import type { ScreenResponse } from '@agent-desktop/contracts';
import { MAX_UPLOAD_BYTES, type Agent, type Computer } from '@agent-desktop/public-contracts';
import { screenResponseSchema } from '@agent-desktop/public-contracts';
import { verifyScreenTicket } from '@agent-desktop/sandbox-adapters';
import { createTestApp, ownerHeaders, withDefaultOwner } from '../../__tests__/test-app.js';
import type { ComputerdClient } from '../../computerd.js';
import { getConfig } from '../../config.js';

const SECRET = getConfig().SCREEN_TICKET_SECRET;

const SANDBOX = 'ie86cnaudoqihfxpqrbzu';

function screenDoc(controller: 'agent' | 'user'): ScreenResponse {
  return {
    id: 'scr-1',
    ownerId: 'member-robin',
    computerId: SANDBOX,
    agentId: 'agent-atlas',
    displayNo: 2,
    state: 'live',
    controller,
    controlEpoch: controller === 'user' ? 1 : 0,
    title: 'agent-atlas screen',
    resolution: '1280x800',
    lastUsedAt: new Date().toISOString(),
    lastVncPort: 5902,
    lastWebPort: 6082,
  };
}

function fakeComputerd(controller: 'agent' | 'user'): ComputerdClient {
  return {
    computer: async () => ({ sandboxId: SANDBOX, template: 'desktop-debian', screens: [], metrics: null }),
    screens: async () => [screenDoc(controller)],
    screenById: async (id) => (id === 'scr-1' ? screenDoc(controller) : null),
    ensureScreen: async () => screenDoc('agent'),
    takeOver: async () => ({ ...screenDoc('user'), changed: true }),
    returnControl: async () => ({ ...screenDoc('agent'), changed: true }),
    controlState: async () => null,
    macStop: async () => ({ paired: false, online: false }),
    screenshot: async () => ({ data: '', mimeType: 'image/png', width: 1280, height: 800, displayNo: 2 }),
    browser: async () => { throw new Error('no browser in this test'); },
    elements: async () => ({ screenId: 'scr-1', width: 1280, height: 800, elements: [] }),
    pasteClipboard: async () => ({ kind: 'image', path: 'Pictures/Pasted/x.png' }),
    copyClipboard: async () => ({ kind: 'empty' }),
    stopProcess: async (_agentId, handle) => ({ handle, state: 'stopped', exitCode: null }),
    pause: async () => undefined,
    resume: async () => undefined,
    computerState: async () => 'none' as const,
    macStatus: async () => ({ paired: false, online: false }),
    macPair: async () => { throw new Error('no Mac in this test'); },
    macRevoke: async () => ({ paired: false, online: false }),
    runtime: async () => ({ kind: 'cloud' as const, image: { state: 'ready' as const } }),
  };
}

/** An owned agent the screen routes can bind; the same shape POST /v1/agents persists. */
function ownedAgent(id: string, ownerId = 'member-robin'): Agent & { ownerId: string } {
  const now = new Date().toISOString();
  return {
    id,
    name: 'Atlas',
    handle: 'atlas',
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'New agent',
    status: 'idle',
    section: 'Inbox',
    pinned: false,
    lastActivity: 'Just created',
    unreadCount: 0,
    model: {
      planner: { provider: 'openai', model: 'gpt-4' },
      computer: { provider: 'openai', model: 'gpt-4-vision' },
      fast: { provider: 'openai', model: 'gpt-3.5-turbo' },
    },
    channels: [{ kind: 'chat', status: 'connected', detail: 'In-app chat', audience: 'You' }],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdBy: ownerId,
    ownerId,
    createdAt: now,
    updatedAt: now,
  };
}

async function build(controller: 'agent' | 'user') {
  const store: Store = withDefaultOwner(createMemoryStore(), getConfig().OWNER_ID);
  const app = createTestApp({ store, bus: createMemoryStore().eventBus, enqueuer: noopEnqueuer(), computerd: fakeComputerd(controller) });
  await store.put('agents', ownedAgent('agent-atlas'));
  return app;
}

function noopEnqueuer() {
  return {
    enqueue: async () => ({ accepted: true }),
    stopRun: async () => undefined,
    resolveAwakeable: async () => undefined,
    scheduleRoutine: async () => undefined,
  };
}

const auth = { ...ownerHeaders(getConfig().OWNER_ID), 'content-type': 'application/json' };

describe('public screen API', () => {
  let userApp: Hono;
  let agentApp: Hono;
  beforeEach(async () => {
    userApp = await build('user');
    agentApp = await build('agent');
    // Ensure the public computer row exists so screens map onto it.
    await userApp.request('/v1/computers/ensure', { method: 'POST', headers: auth });
    await agentApp.request('/v1/computers/ensure', { method: 'POST', headers: auth });
  });

  it('reports screens with the public computer id, never the sandbox id', async () => {
    const response = await userApp.request('/v1/computers/computer-member-robin/screens', { headers: auth });
    const body = (await response.json()) as { items: Array<{ computerId: string }> };
    expect(body.items[0]?.computerId).toBe('computer-member-robin');
    expect(body.items[0]?.computerId).not.toBe(SANDBOX);
  });

  it('downgrades a watcher to read-only even while the user holds control', async () => {
    const response = await userApp.request('/v1/screens/scr-1/stream', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ control: false }),
    });
    const body = (await response.json()) as { url: string; control: boolean };
    expect(body.control).toBe(false);
    expect(claimOf(body.url).control).toBe(false);
  });

  it('grants control only when requested and the user controls the screen', async () => {
    const held = await userApp.request('/v1/screens/scr-1/stream', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ control: true }),
    });
    expect(((await held.json()) as { control: boolean }).control).toBe(true);

    const notHeld = await agentApp.request('/v1/screens/scr-1/stream', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ control: true }),
    });
    expect(((await notHeld.json()) as { control: boolean }).control).toBe(false);
  });

  it('carries the authenticated owner on every screen route and parses as ScreenResponse', async () => {
    for (const [path, init] of [
      ['/v1/computers/computer-member-robin/screens', { headers: auth }],
      ['/v1/computers/computer-member-robin/agents/agent-atlas/screen', { headers: auth }],
    ] as const) {
      const response = await userApp.request(path, init);
      expect(response.status).toBe(200);
      const body = (await response.json()) as unknown;
      const items = Array.isArray((body as { items?: unknown }).items)
        ? ((body as { items: unknown[] }).items as unknown[])
        : [body];
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        const parsed = screenResponseSchema.safeParse(item);
        expect(parsed.success).toBe(true);
        expect((item as { ownerId?: unknown }).ownerId).toBe('member-robin');
      }
    }

    for (const [path, method] of [
      ['/v1/computers/computer-member-robin/screens', 'POST'],
      ['/v1/screens/scr-1/take-over', 'POST'],
      ['/v1/screens/scr-1/return-control', 'POST'],
    ] as const) {
      const response = await userApp.request(path, {
        method,
        headers: auth,
        body: JSON.stringify({ agentId: 'agent-atlas' }),
      });
      expect(response.status).toBe(200);
      const parsed = screenResponseSchema.safeParse(await response.json());
      expect(parsed.success).toBe(true);
    }
  });

  it('rejects a screen owned by someone else instead of leaking it', async () => {
    const foreign = {
      ...screenDoc('agent'),
      id: 'scr-foreign',
      ownerId: 'member-someone-else',
      agentId: 'agent-atlas',
    };
    const store: Store = withDefaultOwner(createMemoryStore(), getConfig().OWNER_ID);
    const app = createTestApp({ store, bus: createMemoryStore().eventBus, enqueuer: noopEnqueuer(), computerd: { ...fakeComputerd('agent'), screens: async () => [foreign] } });
    await app.request('/v1/computers/ensure', { method: 'POST', headers: auth });
    const response = await app.request('/v1/computers/computer-member-robin/screens', {
      headers: auth,
    });
    expect(response.status).toBe(403);
  });

  it('answers take-over, return-control, screenshot and stream on another owner\'s agent as an unknown screen', async () => {
    const acted: string[] = [];
    const store: Store = withDefaultOwner(createMemoryStore(), getConfig().OWNER_ID);
    const app = createTestApp({ store, bus: createMemoryStore().eventBus, enqueuer: noopEnqueuer(), computerd: {
        ...fakeComputerd('agent'),
        takeOver: async (agentId) => { acted.push(agentId); return { ...screenDoc('user'), changed: true }; },
        returnControl: async (agentId) => { acted.push(agentId); return { ...screenDoc('agent'), changed: true }; },
        screenshot: async ({ agentId }) => { acted.push(agentId); return { data: '', mimeType: 'image/png', width: 1, height: 1, displayNo: 2 }; },
      } });
    await store.put('agents', ownedAgent('agent-atlas', 'member-someone-else'));
    const routes: Array<{ path: string; method: string }> = [
      { path: '/v1/screens/scr-1/take-over', method: 'POST' },
      { path: '/v1/screens/scr-1/return-control', method: 'POST' },
      { path: '/v1/screens/scr-1/screenshot', method: 'GET' },
      { path: '/v1/screens/scr-1/stream', method: 'POST' },
    ];
    for (const { path, method } of routes) {
      const response = await app.request(path, { method, headers: auth });
      expect(response.status, path).toBe(404);
    }
    expect(acted).toEqual([]);
  });
});

/** Pull the ticket out of a returned ws url and verify it, so a forged claim cannot pass. */
function claimOf(url: string) {
  const ticket = new URL(url).searchParams.get('t') ?? '';
  const claims = verifyScreenTicket(ticket, SECRET);
  expect(claims).not.toBeNull();
  return { control: claims?.control ?? null };
}

/** Record every provider screen allocation so a rejected request can prove it allocated none. */
function recordingComputerd(allocated: string[]): ComputerdClient {
  return {
    ...fakeComputerd('agent'),
    ensureScreen: async (agentId) => {
      allocated.push(agentId);
      return { ...screenDoc('agent'), id: `scr-${agentId}`, agentId };
    },
  };
}

async function buildWith(computerd: ComputerdClient) {
  const store: Store = withDefaultOwner(createMemoryStore(), getConfig().OWNER_ID);
  const bus = createMemoryStore().eventBus;
  const app = createTestApp({ store, bus, enqueuer: noopEnqueuer(), computerd });
  // A real owned agent: the same POST /v1/agents flow the app uses on first run.
  const created = await app.request('/v1/agents', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'Fresh QA' }),
  });
  const agent = (await created.json()) as { id: string };
  return { app, store, agentId: agent.id };
}

describe('computer ensure binds one agent', () => {
  it('allocates the requested agent display and persists the binding', async () => {
    const allocated: string[] = [];
    const { app, agentId } = await buildWith(recordingComputerd(allocated));

    const response = await app.request('/v1/computers/ensure', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agentId }),
    });
    expect(response.status).toBe(200);
    const computer = (await response.json()) as Computer;
    expect(computer.agentIds).toContain(agentId);
    expect(computer.screens?.map((s) => s.agentId)).toContain(agentId);
    expect(allocated).toEqual([agentId]);

    // The binding is persisted, so a later list still associates the agent.
    const listed = await app.request('/v1/computers', { headers: auth });
    const page = (await listed.json()) as { items: Computer[] };
    expect(page.items[0]?.agentIds).toContain(agentId);
  });

  it('drops ids of deleted agents from the computer row on the next ensure', async () => {
    const { app, store, agentId } = await buildWith(recordingComputerd([]));
    await app.request('/v1/computers/ensure', { method: 'POST', headers: auth });
    const row = (await store.list('computers', { limit: 1 })).items[0];
    await store.patch('computers', row?.id ?? '', { agentIds: ['agt-1791343612733', 'agt-1791344789882'] });
    const response = await app.request('/v1/computers/ensure', { method: 'POST', headers: auth, body: JSON.stringify({ agentId }) });
    expect(((await response.json()) as Computer).agentIds).toEqual([agentId]);
  });

  it('refuses an agent the owner cannot use before any provider effect', async () => {
    const allocated: string[] = [];
    const { app, store } = await buildWith(recordingComputerd(allocated));

    const response = await app.request('/v1/computers/ensure', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agentId: 'agent-someone-else' }),
    });
    expect(response.status).toBe(404);
    expect(allocated).toEqual([]);
    expect((await store.list('computers')).items).toHaveLength(0);
  });

  it('still creates the computer on an empty-body ensure without allocating a screen', async () => {
    const allocated: string[] = [];
    const { app } = await buildWith(recordingComputerd(allocated));

    const response = await app.request('/v1/computers/ensure', { method: 'POST', headers: auth });
    expect(response.status).toBe(200);
    const computer = (await response.json()) as Computer;
    expect(computer.agentIds).toEqual([]);
    expect(allocated).toEqual([]);
  });

  it('rejects a malformed agentId instead of provisioning a machine', async () => {
    const allocated: string[] = [];
    const { app, store } = await buildWith(recordingComputerd(allocated));

    const numeric = await app.request('/v1/computers/ensure', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agentId: 42 }),
    });
    expect(numeric.status).toBe(400);
    const unparseable = await app.request('/v1/computers/ensure', {
      method: 'POST',
      headers: auth,
      body: '{not json',
    });
    expect(unparseable.status).toBe(400);
    expect(allocated).toEqual([]);
    expect((await store.list('computers')).items).toHaveLength(0);
  });

  it('refuses the screens route for an agent the owner cannot use, before allocating', async () => {
    const allocated: string[] = [];
    const { app } = await buildWith(recordingComputerd(allocated));

    const response = await app.request('/v1/computers/computer-anything/screens', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agentId: 'agent-someone-else' }),
    });
    expect(response.status).toBe(404);
    expect(allocated).toEqual([]);
  });

  it('clipboard: only the user who holds the screen may paste or copy, and an oversize paste is refused before it is read', async () => {
    const agentApp = await build('agent');
    const userApp = await build('user');
    const copyWhileAgent = await agentApp.request('/v1/screens/scr-1/clipboard', { headers: auth });
    expect(copyWhileAgent.status).toBe(409);
    expect(await copyWhileAgent.json()).toMatchObject({ error: { code: 'NOT_IN_CONTROL' } });

    const oversize = await userApp.request('/v1/screens/scr-1/clipboard', {
      method: 'POST',
      headers: { ...auth, 'content-length': String(MAX_UPLOAD_BYTES * 2) },
      body: '{}',
    });
    expect(oversize.status).toBe(413);

    const malformed = await userApp.request('/v1/screens/scr-1/clipboard', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ kind: 'image' }),
    });
    expect(malformed.status).toBe(400);

    const pasted = await userApp.request('/v1/screens/scr-1/clipboard', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ kind: 'image', mimeType: 'image/png', contentBase64: 'iVBORw==' }),
    });
    expect(await pasted.json()).toEqual({ kind: 'image', path: 'Pictures/Pasted/x.png' });

    const copied = await userApp.request('/v1/screens/scr-1/clipboard', { headers: auth });
    expect(await copied.json()).toEqual({ kind: 'empty' });
  });
});

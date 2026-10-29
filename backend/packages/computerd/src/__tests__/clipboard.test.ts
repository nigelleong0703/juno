/**
 * computerd's clipboard side channel (M-CLIP) with the fake provider: bearer required, the user must hold the screen, the
 * four kinds a copy can answer, the paste bodies, and the upload limit (decoded bytes and the request's own length).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { createFakeProvider, createScreenPool, MAX_LIVE_SCREENS, type FakeProvider } from '@agent-desktop/sandbox-adapters';
import { MAX_UPLOAD_BYTES, type Agent } from '@agent-desktop/public-contracts';
import { createComputerApp } from '../transport/routes.js';
import { createLifecycle } from '../modules/computers/lifecycle.js';
import { createComputerStateStore } from '../infrastructure/computer-state.js';

const TOKEN = 'test-token';
const AGENT = 'agent-a';

function agent(id: string): Agent {
  return {
    id,
    name: id,
    handle: id,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'tester',
    status: 'idle',
    section: 'Work',
    pinned: false,
    lastActivity: '',
    unreadCount: 0,
    model: {
      planner: { provider: 'scripted', model: 'test' },
      computer: { provider: 'scripted', model: 'test' },
      fast: { provider: 'scripted', model: 'test' },
    },
    channels: [],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function build() {
  const store = createMemoryStore();
  await store.put('agents', agent(AGENT));
  const provider = createFakeProvider();
  const pool = createScreenPool(MAX_LIVE_SCREENS);
  const state = createComputerStateStore('', { sandboxId: 'sbx-test', template: 'desktop-debian' });
  const lifecycle = createLifecycle({
    store,
    provider,
    pool,
    state,
    ownerId: 'owner-1',
    host: { template: 'desktop-debian', resolution: '1280x800', timeoutMs: 1000, ramGb: 2, vcpu: 2, idlePauseMinutes: 30 },
    secret: TOKEN,
  });
  const app = createComputerApp({ lifecycle, provider, token: TOKEN, requireAuth: true });
  return { app, provider };
}

type App = Awaited<ReturnType<typeof build>>['app'];

function request(app: App, method: 'GET' | 'POST', path: string, body?: unknown, extra: Record<string, string> = {}) {
  return app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      'x-agent-id': AGENT,
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe('computerd clipboard side channel', () => {
  let app: App;
  let provider: FakeProvider;

  beforeEach(async () => {
    ({ app, provider } = await build());
    await request(app, 'POST', '/v1/screens/self/ensure');
  });

  /** The user takes the screen, as the owner's take-over does. */
  async function userHoldsScreen() {
    const taken = await request(app, 'POST', '/v1/screens/self/take-over');
    expect(await taken.json()).toMatchObject({ controller: 'user' });
  }

  it('refuses a request without the bearer, for both directions', async () => {
    const copy = await app.request('/v1/screens/self/clipboard', { method: 'GET', headers: { 'x-agent-id': AGENT } });
    expect(copy.status).toBe(403);
    const paste = await app.request('/v1/screens/self/clipboard', { method: 'POST', headers: { 'x-agent-id': AGENT, 'content-type': 'application/json' }, body: '{}' });
    expect(paste.status).toBe(403);
  });

  it('refuses both directions while the agent holds the screen', async () => {
    const copy = await request(app, 'GET', '/v1/screens/self/clipboard');
    expect(copy.status).toBe(409);
    expect(await copy.json()).toMatchObject({ code: 'NOT_IN_CONTROL' });
    const paste = await request(app, 'POST', '/v1/screens/self/clipboard', { kind: 'image', mimeType: 'image/png', contentBase64: b64(PNG) });
    expect(paste.status).toBe(409);
    expect(provider.state.pasted).toHaveLength(0);
  });

  it('puts a pasted image on the computer and answers where it went', async () => {
    await userHoldsScreen();
    const response = await request(app, 'POST', '/v1/screens/self/clipboard', { kind: 'image', mimeType: 'image/png', contentBase64: b64(PNG) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: 'image', path: 'Pictures/Pasted/fake.png' });
    const [pasted] = provider.state.pasted;
    expect(pasted).toMatchObject({ kind: 'image', mimeType: 'image/png' });
    expect(Buffer.from(pasted?.kind === 'image' ? pasted.bytes : new Uint8Array()).equals(Buffer.from(PNG))).toBe(true);
  });

  it('saves pasted files and answers each saved name and path', async () => {
    await userHoldsScreen();
    const response = await request(app, 'POST', '/v1/screens/self/clipboard', {
      kind: 'files',
      files: [{ name: 'report.pdf', contentBase64: b64(new Uint8Array([37, 80, 68, 70])) }],
    });
    expect(await response.json()).toEqual({ kind: 'files', saved: [{ name: 'report.pdf', path: 'Downloads/report.pdf' }] });
  });

  it('refuses a body that is not valid base64 or does not match the contract', async () => {
    await userHoldsScreen();
    const notBase64 = await request(app, 'POST', '/v1/screens/self/clipboard', { kind: 'image', mimeType: 'image/png', contentBase64: 'not base64!' });
    expect(notBase64.status).toBe(400);
    expect(await notBase64.json()).toMatchObject({ code: 'invalid_clipboard' });
    const wrongShape = await request(app, 'POST', '/v1/screens/self/clipboard', { kind: 'image', mimeType: 'image/gif', contentBase64: b64(PNG) });
    expect(wrongShape.status).toBe(400);
    expect(provider.state.pasted).toHaveLength(0);
  });

  it('refuses a paste over the upload limit, by decoded size, and by the request length before reading it', async () => {
    await userHoldsScreen();
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    const tooBig = await request(app, 'POST', '/v1/screens/self/clipboard', { kind: 'image', mimeType: 'image/png', contentBase64: b64(big) });
    expect(tooBig.status).toBe(413);
    expect(await tooBig.json()).toMatchObject({ code: 'too_large' });
    const declared = await request(app, 'POST', '/v1/screens/self/clipboard', { kind: 'image', mimeType: 'image/png', contentBase64: b64(PNG) }, { 'content-length': String(MAX_UPLOAD_BYTES * 3) });
    expect(declared.status).toBe(413);
    expect(provider.state.pasted).toHaveLength(0);
  });

  it('refuses files that together pass the upload limit', async () => {
    await userHoldsScreen();
    const half = b64(new Uint8Array(Math.floor(MAX_UPLOAD_BYTES / 2) + 1));
    const response = await request(app, 'POST', '/v1/screens/self/clipboard', {
      kind: 'files',
      files: [
        { name: 'a.bin', contentBase64: half },
        { name: 'b.bin', contentBase64: half },
      ],
    });
    expect(response.status).toBe(413);
  });

  it('answers an empty clipboard as empty', async () => {
    await userHoldsScreen();
    expect(await (await request(app, 'GET', '/v1/screens/self/clipboard')).json()).toEqual({ kind: 'empty' });
  });

  it('answers copied text as text', async () => {
    await userHoldsScreen();
    provider.state.clipboard = { kind: 'text', text: 'héllo' };
    expect(await (await request(app, 'GET', '/v1/screens/self/clipboard')).json()).toEqual({ kind: 'text', text: 'héllo' });
  });

  it('answers a copied image as PNG base64', async () => {
    await userHoldsScreen();
    provider.state.clipboard = { kind: 'image', bytes: PNG };
    expect(await (await request(app, 'GET', '/v1/screens/self/clipboard')).json()).toEqual({ kind: 'image', mimeType: 'image/png', contentBase64: b64(PNG) });
  });

  it('answers a copied file with its name, size and bytes', async () => {
    await userHoldsScreen();
    provider.state.clipboard = { kind: 'file', name: 'report.pdf', bytes: PNG };
    expect(await (await request(app, 'GET', '/v1/screens/self/clipboard')).json()).toEqual({
      kind: 'file',
      name: 'report.pdf',
      sizeBytes: PNG.byteLength,
      contentBase64: b64(PNG),
    });
  });

  it('answers 413 for a copied item over the upload limit', async () => {
    await userHoldsScreen();
    provider.state.clipboard = { kind: 'image', bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1) };
    const response = await request(app, 'GET', '/v1/screens/self/clipboard');
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'too_large' });
  });
});

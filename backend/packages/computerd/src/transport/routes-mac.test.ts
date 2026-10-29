import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { createFakeProvider, createScreenPool, MAX_LIVE_SCREENS, unavailable } from '@agent-desktop/sandbox-adapters';
import type { Agent } from '@agent-desktop/public-contracts';
import type { DesktopAction } from 'juno-link/protocol';
import type { MacComputer } from '../modules/mac/mac-computer.js';
import { createLifecycle } from '../modules/computers/lifecycle.js';
import { createComputerStateStore } from '../infrastructure/computer-state.js';
import { createComputerApp } from './routes.js';

const TOKEN = 'test-token';

function agent(): Agent {
  return {
    id: 'agent-a', name: 'agent-a', handle: 'agent-a', avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'tester', status: 'idle', section: 'Work', pinned: false, lastActivity: '', unreadCount: 0,
    model: { planner: { provider: 'scripted', model: 'test' }, computer: { provider: 'scripted', model: 'test' }, fast: { provider: 'scripted', model: 'test' } },
    channels: [], macAccess: true, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

async function build(desktopImpl?: (action: DesktopAction, input: Record<string, unknown>) => Promise<unknown>) {
  const store = createMemoryStore();
  await store.put('agents', agent());
  const provider = createFakeProvider();
  let sandboxActs = 0;
  const act = provider.act.bind(provider);
  provider.act = async (...args) => {
    sandboxActs += 1;
    return act(...args);
  };
  const lifecycle = createLifecycle({
    store, provider, pool: createScreenPool(MAX_LIVE_SCREENS), state: createComputerStateStore('', { sandboxId: 'sbx-test', template: 'desktop-debian' }),
    ownerId: 'owner-1', host: { template: 'desktop-debian', resolution: '1280x800', timeoutMs: 1000, ramGb: 2, vcpu: 2, idlePauseMinutes: 30 }, secret: TOKEN,
  });
  const desktopCalls: Array<{ action: DesktopAction; input: Record<string, unknown> }> = [];
  const mac: MacComputer = {
    status: async () => ({ paired: true, online: true }),
    ensureControl: async () => undefined,
    stop: async () => ({ paired: true, online: true }),
    environment: async () => ({ os: 'macOS', platform: 'darwin', user: 'robin', home: '/Users/robin', workingDirectory: '/Users/robin/Juno', pathStyle: 'posix', kind: 'mac' }),
    shell: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    readFile: async () => ({ content: '', bytes: 0 }),
    writeFile: async (input) => ({ path: input.path, bytes: 0 }),
    processes: { start: async () => ({ handle: 'p1', pid: 1, state: 'running', exitCode: null, startedAt: '' }), read: async () => { throw new Error('unused'); }, write: async () => { throw new Error('unused'); }, stop: async () => { throw new Error('unused'); }, cleanup: async () => undefined },
    withTransfer: async (_signal, fn) => fn({
      kindOf: async () => 'file',
      readFile: async () => new Uint8Array(),
      writeFile: async () => undefined,
      readFolder: async () => new Uint8Array(),
      writeFolder: async () => undefined,
    }),
    desktop: async (_agent, action, input) => {
      desktopCalls.push({ action, input });
      return desktopImpl === undefined ? {} : desktopImpl(action, input);
    },
  };
  const app = createComputerApp({ lifecycle, provider, token: TOKEN, requireAuth: true, mac });
  return { app, sandboxActs: () => sandboxActs, desktopCalls };
};

function post(app: ReturnType<typeof createComputerApp>, path: string, body: unknown = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'x-agent-id': 'agent-a', 'x-computer': 'mac' },
    body: JSON.stringify(body),
  });
}

describe('Mac desktop routes', () => {
  it('relays Mail, Calendar and Reminders calls to the Mac for allow-listed tools only', async () => {
    const built = await build(async () => ({ text: 'Sent to a@b.test' }));
    const sent = await post(built.app, '/v1/screens/self/mac-apps', { tool: 'mail_send', args: { to: ['a@b.test'], subject: 's', body: 'b' } });
    expect(await sent.json()).toEqual({ text: 'Sent to a@b.test' });
    expect((await post(built.app, '/v1/screens/self/mac-apps', { tool: 'shell', args: {} })).status).toBe(400);
    expect(built.desktopCalls).toEqual([{ action: 'mac_apps', input: { tool: 'mail_send', args: { to: ['a@b.test'], subject: 's', body: 'b' } } }]);
    expect(built.sandboxActs()).toBe(0);
  });

  it('serves snapshot / act / verify and browser actions without allocating or calling the sandbox', async () => {
    const built = await build(async (action, input) => action === 'browser'
      ? { action: input['action'], tabs: [] }
      : { ok: true, text: `${action} done` });
    const steps = [{ tool: 'click', args: { element_token: 's1:3' } }];
    expect(await (await post(built.app, '/v1/screens/self/mac/snapshot', { app: 'Notes', query: 'Save' })).json()).toEqual({ ok: true, text: 'snapshot done' });
    expect(await (await post(built.app, '/v1/screens/self/mac/act', { app: 'Notes', steps, foreground: true })).json()).toEqual({ ok: true, text: 'act done' });
    expect(await (await post(built.app, '/v1/screens/self/mac/verify', { app: 'Notes', expect: [{ window: { exists: true } }] })).json()).toEqual({ ok: true, text: 'verify done' });
    const browser = await post(built.app, '/v1/screens/self/browser/action', { action: 'tabs' });
    expect(await browser.json()).toEqual({ action: 'tabs', tabs: [] });
    expect(built.desktopCalls).toEqual([
      { action: 'snapshot', input: { app: 'Notes', query: 'Save' } },
      { action: 'act', input: { app: 'Notes', steps, foreground: true } },
      { action: 'verify', input: { app: 'Notes', expect: [{ window: { exists: true } }] } },
      { action: 'browser', input: { action: 'tabs' } },
    ]);
    expect(built.sandboxActs()).toBe(0);
  });

  it('carries the navigate action across the Mac browser RPC', async () => {
    const built = await build(async (_action, input) => ({ action: 'navigate', url: input['url'], title: 'Fixture', tab: 'mt1' }));
    const response = await post(built.app, '/v1/screens/self/browser/navigate', { url: 'https://example.com' });
    expect(response.status).toBe(200);
    expect(built.desktopCalls).toEqual([{ action: 'browser', input: { action: 'navigate', url: 'https://example.com' } }]);
    expect(built.sandboxActs()).toBe(0);
  });

  it('fails closed for an unsupported Mac route instead of falling through to the sandbox', async () => {
    const built = await build();
    const response = await post(built.app, '/v1/screens/self/ensure');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'bad_request', message: expect.stringContaining('no sandbox fallback') });
    expect(built.desktopCalls).toEqual([]);
    expect(built.sandboxActs()).toBe(0);
  });

  it('reports a disconnect after dispatch as ambiguous and never retries the action', async () => {
    const built = await build(async () => { throw unavailable('connection dropped'); });
    const response = await post(built.app, '/v1/screens/self/mac/act', { app: 'Notes', steps: [{ tool: 'press_key', args: { key: 'return' } }] });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'unavailable', message: 'connection dropped' });
    expect(built.desktopCalls).toEqual([{ action: 'act', input: { app: 'Notes', steps: [{ tool: 'press_key', args: { key: 'return' } }] } }]);
    expect(built.sandboxActs()).toBe(0);
  });

  it('refuses the old coordinate routes and the take-over mode on the Mac instead of running them', async () => {
    const built = await build();
    for (const path of ['screenshot', 'click', 'double-click', 'right-click', 'move', 'type', 'key', 'scroll', 'control']) {
      const response = await post(built.app, `/v1/screens/self/${path}`, { x: 1, y: 2, text: 'a', key: 'a', deltaY: 1, mode: 'user' });
      expect(response.status, path).toBe(400);
    }
    expect(built.desktopCalls).toEqual([]);
    expect(built.sandboxActs()).toBe(0);
  });

  it('refuses a malformed act before it reaches the Mac', async () => {
    const built = await build();
    expect((await post(built.app, '/v1/screens/self/mac/act', { app: 'Notes', steps: [] })).status).toBe(400);
    expect((await post(built.app, '/v1/screens/self/mac/act', { steps: [{ tool: 'click' }] })).status).toBe(400);
    expect(built.desktopCalls).toEqual([]);
  });
});

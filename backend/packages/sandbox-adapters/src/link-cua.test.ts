import { createServer, type Server } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { startLinkDaemon, type LinkDaemon } from 'juno-link/daemon';
import type { CuaClient } from 'juno-link/cua';
import { createLinkHub, type LinkHub } from './link-hub.js';

const LINK_ID = 'link-cua-0001';
const NO_CUA_ID = 'link-cua-0002';

describe('cua desktop actions through the link (hub + daemon)', () => {
  let http: Server;
  let hub: LinkHub;
  let daemon: LinkDaemon;
  let bare: LinkDaemon;
  let dir: string;
  const tools: string[] = [];
  let hung = false;

  const cua: CuaClient = {
    async call(tool, _args, signal) {
      tools.push(tool);
      if (hung) await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      if (tool === 'list_windows') return { isError: false, json: { windows: [{ app_name: 'Notes', pid: 41, window_id: 7, title: 'n', is_on_screen: true }] } };
      return { isError: false, json: { snapshot_id: 's1', element_count: 1, tree_markdown: '- [0] AXWindow' } };
    },
  };

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'juno-link-cua-')));
    hub = createLinkHub({ secret: 's3cret' });
    http = createServer();
    new WebSocketServer({ server: http, path: '/v1/computer-link' }).on('connection', (socket) => hub.accept(socket));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const url = 'ws://127.0.0.1:' + (http.address() as { port: number }).port + '/v1/computer-link';
    const common = { scratchDir: join(dir, 'scratch'), backoff: { minMs: 50, maxMs: 1_500 } };
    daemon = startLinkDaemon({ ...common, loadConfig: () => ({ url, id: LINK_ID, token: hub.tokenFor(LINK_ID) }), cua });
    bare = startLinkDaemon({ ...common, loadConfig: () => ({ url, id: NO_CUA_ID, token: hub.tokenFor(NO_CUA_ID) }) });
    await hub.waitFor(LINK_ID, 10_000);
    await hub.waitFor(NO_CUA_ID, 10_000);
  });

  afterAll(() => {
    daemon.stop();
    bare.stop();
    hub.close();
    http.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers a snapshot from cua-driver and advertises the desktop', async () => {
    const result = await hub.get(LINK_ID)?.desktop({ agentId: 'agent-1', action: 'snapshot', input: { app: 'Notes' } });
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining('AXWindow') });
    expect(await hub.get(LINK_ID)?.health()).toMatchObject({ host: { desktop: true } });
  });

  it('refuses the cua actions on a Mac that has no cua-driver', async () => {
    await expect(hub.get(NO_CUA_ID)?.desktop({ agentId: 'agent-1', action: 'act', input: { app: 'Notes', steps: [] } })).rejects.toThrow(/update/);
  });

  it('Stop cancels the cua call in flight and blocks new ones until resume', async () => {
    hung = true;
    const running = hub.get(LINK_ID)?.desktop({ agentId: 'agent-1', action: 'snapshot', input: { app: 'Notes' } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(daemon.activity().running).toBeGreaterThanOrEqual(1);
    daemon.pause();
    await expect(running).rejects.toThrow(/Stop/);
    hung = false;
    const before = tools.length;
    await expect(hub.get(LINK_ID)?.desktop({ agentId: 'agent-1', action: 'snapshot', input: { app: 'Notes' } })).rejects.toThrow(/Stop/);
    expect(tools.length).toBe(before);
    daemon.resume();
    await expect(hub.get(LINK_ID)?.desktop({ agentId: 'agent-1', action: 'snapshot', input: { app: 'Notes' } })).resolves.toMatchObject({ ok: true });
  });

  it('a Stopped Mac answers user_control (paused), not not_allowed', async () => {
    daemon.pause();
    try {
      await expect(hub.get(LINK_ID)?.desktop({ agentId: 'agent-1', action: 'snapshot', input: { app: 'Notes' } })).rejects.toMatchObject({ code: 'user_control' });
    } finally {
      daemon.resume();
    }
  });
});

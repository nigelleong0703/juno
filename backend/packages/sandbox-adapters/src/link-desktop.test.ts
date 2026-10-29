import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { startLinkDaemon, type LinkDaemon } from 'juno-link/daemon';
import type { DesktopRequest } from 'juno-link/protocol';
import { createLinkHub, type LinkHub } from './link-hub.js';
import { createLinkRuntime } from './link-runtime.js';

const LINK_ID = 'link-desktop-0001';
const OLD_ID = 'link-desktop-0002';
const SECRET = 's3cret';

describe('computer link desktop RPC (hub + daemon)', () => {
  let http: Server;
  let hub: LinkHub;
  let daemon: LinkDaemon;
  let old: LinkDaemon;
  let dir: string;
  let url = '';
  const seen: DesktopRequest[] = [];
  let stopCalls = 0;

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'juno-link-desktop-')));
    hub = createLinkHub({ secret: SECRET });
    http = createServer();
    const wss = new WebSocketServer({ server: http, path: '/v1/computer-link' });
    wss.on('connection', (socket) => hub.accept(socket));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    url = 'ws://127.0.0.1:' + (http.address() as { port: number }).port + '/v1/computer-link';
    daemon = startLinkDaemon({
      loadConfig: () => ({ url, id: LINK_ID, token: hub.tokenFor(LINK_ID) }),
      scratchDir: join(dir, 'scratch'),
      backoff: { minMs: 50, maxMs: 1_500 },
      desktop: {
        handle: async (request: DesktopRequest, signal: AbortSignal) => {
          seen.push(request);
          if ((request.input as Record<string, unknown>)['wait'] === true) {
            await new Promise<never>((_resolve, reject) => {
              if (signal.aborted) return reject(new Error('handler saw abort'));
              signal.addEventListener('abort', () => reject(new Error('handler saw abort')), { once: true });
            });
          }
          if ((request.input as Record<string, unknown>)['big'] === true) return 'x'.repeat(2 * 1024 * 1024);
          return { ok: true, action: request.action, agentId: request.agentId };
        },
        stop: () => {
          stopCalls += 1;
        },
      },
    });
    old = startLinkDaemon({
      loadConfig: () => ({ url, id: OLD_ID, token: hub.tokenFor(OLD_ID) }),
      scratchDir: join(dir, 'scratch-old'),
      backoff: { minMs: 50, maxMs: 1_500 },
    });
    await hub.waitFor(LINK_ID, 10_000);
    await hub.waitFor(OLD_ID, 10_000);
  });

  afterAll(() => {
    daemon.stop();
    old.stop();
    hub.close();
    http.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs a desktop operation and returns the host result', async () => {
    const result = await hub.get(LINK_ID)?.desktop({ agentId: 'agent-1', action: 'permissions', input: {} });
    expect(result).toEqual({ ok: true, action: 'permissions', agentId: 'agent-1' });
    expect(await hub.get(LINK_ID)?.health()).toMatchObject({ ok: true, host: { desktop: true } });
  });

  it('refuses unknown actions, bad agent ids and non-object input without reaching the handler', async () => {
    const link = hub.get(LINK_ID);
    const before = seen.length;
    await expect(link?.desktop({ agentId: 'agent-1', action: 'eval' as never, input: {} })).rejects.toThrow(/unknown desktop action/);
    await expect(link?.desktop({ agentId: '', action: 'browser', input: {} })).rejects.toThrow(/agentId/);
    await expect(link?.desktop({ agentId: 'agent-1', action: 'browser', input: 'nope' as never })).rejects.toThrow(/object input/);
    expect(seen.length).toBe(before);
  });

  it('fails an oversized desktop result truthfully instead of truncating', async () => {
    await expect(hub.get(LINK_ID)?.desktop({ agentId: 'agent-1', action: 'permissions', input: { big: true } })).rejects.toThrow(/limit/);
  });

  it('tells an old host to update instead of running desktop work', async () => {
    await expect(hub.get(OLD_ID)?.desktop({ agentId: 'agent-1', action: 'permissions', input: {} })).rejects.toThrow(/update/);
    expect(await hub.get(OLD_ID)?.health()).not.toMatchObject({ host: { desktop: true } });
  });

  it('cancels a running desktop operation', async () => {
    const abort = new AbortController();
    const running = hub.get(LINK_ID)?.desktop({ agentId: 'agent-1', action: 'audio_start', input: { wait: true } }, abort.signal);
    setTimeout(() => abort.abort(), 200);
    await expect(running).rejects.toThrow(/cancelled/);
  });

  it('stops desktop work on user Stop and stops background recording', async () => {
    const stops = stopCalls;
    const running = hub.get(LINK_ID)?.desktop({ agentId: 'agent-1', action: 'audio_start', input: { wait: true } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(daemon.activity().running).toBeGreaterThanOrEqual(1);
    daemon.pause();
    await expect(running).rejects.toThrow(/Stop/);
    expect(stopCalls).toBeGreaterThan(stops);
    await expect(hub.get(LINK_ID)?.desktop({ agentId: 'agent-1', action: 'permissions', input: {} })).rejects.toThrow(/Stop/);
    daemon.resume();
  });

  it('a disconnect mid-request fails as outcome-unknown and never auto-resends', async () => {
    const clickTag = 'drop-click-' + seen.length;
    const shotTag = 'drop-shot-' + seen.length;
    const clickReq = hub.get(LINK_ID)?.desktop({ agentId: 'agent-1', action: 'browser', input: { wait: true, tag: clickTag } });
    const shotReq = hub.get(LINK_ID)?.desktop({ agentId: 'agent-1', action: 'permissions', input: { wait: true, tag: shotTag } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stops = stopCalls;
    hub.drop(LINK_ID);
    await expect(clickReq).rejects.toThrow(/outcome is unknown/);
    await expect(clickReq).rejects.toThrow(/inspect/i);
    await expect(shotReq).rejects.toThrow(/outcome is unknown/);
    await expect(shotReq).rejects.toThrow(/retried deliberately/);
    await hub.waitFor(LINK_ID, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const count = (t: string) => seen.filter((r) => (r.input as Record<string, unknown>)['tag'] === t).length;
    expect(count(clickTag)).toBe(1);
    expect(count(shotTag)).toBe(1);
    expect(stopCalls).toBeGreaterThan(stops);
    await expect(hub.get(LINK_ID)?.desktop({ agentId: 'agent-1', action: 'permissions', input: {} })).resolves.toEqual({ ok: true, action: 'permissions', agentId: 'agent-1' });
  });

  it('a call on a dead link fails as not-run without touching the Mac', async () => {
    const conn = hub.get(LINK_ID);
    expect(conn?.open).toBe(true);
    const before = seen.length;
    hub.drop(LINK_ID);
    for (let i = 0; i < 100 && conn?.open !== false; i++) await new Promise((r) => setTimeout(r, 20));
    expect(conn?.open).toBe(false);
    await expect(conn?.desktop({ agentId: 'agent-1', action: 'browser', input: {} })).rejects.toThrow(/did not run/);
    expect(seen.length).toBe(before);
    await hub.waitFor(LINK_ID, 10_000);
  });
  it('still runs shell commands after desktop work', async () => {
    const result = await createLinkRuntime({ hub, linkId: LINK_ID }).run('echo hi', { cwd: dir });
    expect(result).toMatchObject({ stdout: 'hi\n', exitCode: 0 });
  });
});

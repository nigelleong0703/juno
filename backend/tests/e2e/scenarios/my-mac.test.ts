import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startLinkDaemon, type DaemonOptions, type LinkDaemon, type LinkStatus } from 'juno-link/daemon';
import type { CuaClient } from 'juno-link/cua';
import type { DeviceDeclaration } from 'juno-link/protocol';
import { createAccount, listenEvents, macDevice, scriptedChat, toolCall, waitForToolActivity, type Account } from '../harness/client';

/**
 * My Mac: a Mac joins as the owner's computer through juno-link (here the real daemon under Node, pointed at a temp folder
 * instead of ~/Juno) and an agent with Mac access works there when a call says on: "mac". Inside the folder files are free; every shell command and any path
 * outside it asks first through the normal approval card; the daemon itself refuses paths outside its folder even when the
 * owner approved; an unpaired or stopped Mac is reported as such, never replaced by the sandbox.
 */
describe('My Mac', () => {
  async function pairAndConnect(account: Account, folder: string, options: { device?: DeviceDeclaration | null; desktop?: DaemonOptions['desktop']; cua?: CuaClient } = {}) {
    const paired = await account.api('POST', '/v1/computers/my-mac', { name: 'Test Mac' });
    expect(paired.status).toBe(201);
    const statuses: LinkStatus[] = [];
    // `device: null` plays the installed 0.1.x app, which declares nothing.
    const device = options.device === undefined ? macDevice() : options.device;
    const daemon: LinkDaemon = startLinkDaemon({
      loadConfig: () => ({ url: paired.body.url, id: paired.body.id, token: paired.body.token }),
      roots: [folder],
      scratchDir: join(folder, '..', 'scratch'),
      backoff: { minMs: 100, maxMs: 500 },
      onStatus: (status) => statuses.push(status),
      ...(device === null ? {} : { device: () => device }),
      ...(options.desktop === undefined ? {} : { desktop: options.desktop }),
      ...(options.cua === undefined ? {} : { cua: options.cua }),
    });
    for (let attempt = 0; attempt < 100 && !(await account.api('GET', '/v1/computers/my-mac')).body.online; attempt += 1) await new Promise((r) => setTimeout(r, 100));
    return { daemon, statuses, paired, device };
  }

  it('works inside the folder, asks for commands and outside paths, refuses outside the folder, and goes offline when unpaired', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-mac-')));
    const folder = join(base, 'Juno');
    const outside = join(base, 'Documents');
    mkdirSync(folder);
    mkdirSync(outside);
    const account = await createAccount('my-mac');
    const events = await listenEvents(account.cookie);
    let daemon: LinkDaemon | undefined;
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Mac Helper' });
      expect(agent.status).toBe(201);
      // The Mac must be paired before an agent can be set to it.
      const early = await account.api('PATCH', `/v1/agents/${agent.body.id}`, { macAccess: true });
      expect(early.status).toBe(409);
      expect((await account.api('PATCH', `/v1/agents/${agent.body.id}`, { macAccess: 'yes' })).status).toBe(400);

      expect((await account.api('GET', '/v1/computers/my-mac')).body).toMatchObject({ paired: false, online: false });
      const linked = await pairAndConnect(account, folder);
      daemon = linked.daemon;
      const status = await account.api('GET', '/v1/computers/my-mac');
      expect(status.body).toMatchObject({ paired: true, online: true, name: 'Test Mac', folder, device: linked.device });
      const set = await account.api('PATCH', `/v1/agents/${agent.body.id}`, { macAccess: true });
      expect(set.status).toBe(200);
      expect(set.body.macAccess).toBe(true);

      const secret = join(outside, 'secret.txt');
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('c1', 'files.write', { path: 'notes/hello.txt', content: 'hello mac', on: 'mac' })] },
        { toolCalls: [toolCall('c2', 'files.read', { path: 'notes/hello.txt', on: 'mac' })] },
        { toolCalls: [toolCall('c3', 'shell.run', { command: 'ls notes && echo listed', on: 'mac' })] },
        { toolCalls: [toolCall('c4', 'files.write', { path: secret, content: 'nope', on: 'mac' })] },
        { text: 'MAC-DONE' },
      ], 'tidy my folder');

      const approve = async (count: number) => {
        const created = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.conversationId === conversationId && events.events.filter((x) => x.data.type === 'request.created' && x.data.request.conversationId === conversationId).length >= count, 40_000);
        const request = events.events.filter((x) => x.data.type === 'request.created' && x.data.request.conversationId === conversationId)[count - 1] ?? created;
        expect(request.data.request.status).toBe('pending');
        const resolved = await account.api('POST', `/v1/requests/${request.data.request.id}/resolve`, { action: 'approve' });
        expect(resolved.status).toBe(200);
        return request.data.request;
      };
      // The command is the first thing that asks: the file write and read inside the folder ran without a card.
      const shellRequest = await approve(1);
      expect(JSON.stringify(shellRequest)).toContain('Mac');
      expect(readFileSync(join(folder, 'notes/hello.txt'), 'utf8')).toBe('hello mac');
      const outsideRequest = await approve(2);
      expect(JSON.stringify(outsideRequest)).toContain('outside');
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes('MAC-DONE'), 40_000);

      const activity = await waitForToolActivity(sessionKey, (a) => a.results.length >= 4);
      expect(activity.results.map((r) => [r.toolName, r.isError])).toEqual([['files.write', false], ['files.read', false], ['shell.run', false], ['files.write', true]]);
      expect(activity.results[1]?.text).toContain('hello mac');
      expect(activity.results[2]?.text).toContain('hello.txt');
      expect(activity.results[2]?.text).toContain('listed');
      // Approved by the owner, still refused by the Mac's own daemon.
      expect(activity.results[3]?.text).toContain('outside the folders');
      expect(existsSync(secret)).toBe(false);

      // The Mac goes away without being unpaired: the agent is told it is offline, nothing falls back to the sandbox.
      daemon.stop();
      for (let attempt = 0; attempt < 100 && (await account.api('GET', '/v1/computers/my-mac')).body.online; attempt += 1) await new Promise((r) => setTimeout(r, 100));
      expect((await account.api('GET', '/v1/computers/my-mac')).body).toMatchObject({ paired: true, online: false });
      const offline = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('o1', 'files.read', { path: 'notes/hello.txt', on: 'mac' })] },
        { text: 'OFFLINE-SEEN' },
      ], 'read it again');
      const seen = await waitForToolActivity(offline.sessionKey, (a) => a.results.length >= 1, 40_000);
      expect(seen.results[0]).toMatchObject({ toolName: 'files.read', isError: true });
      expect(seen.results[0]?.text).toContain('Your Mac was offline before the action was sent');

      // Unpairing revokes the token: the daemon is refused when it dials again.
      const again = await pairAndConnect(account, folder);
      daemon = again.daemon;
      const revoked = await account.api('DELETE', '/v1/computers/my-mac');
      expect(revoked.body).toMatchObject({ paired: false, online: false });
      for (let attempt = 0; attempt < 100 && !again.statuses.includes('unauthorized'); attempt += 1) await new Promise((r) => setTimeout(r, 100));
      expect(again.statuses).toContain('unauthorized');
      const gone = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('g1', 'files.read', { path: 'notes/hello.txt', on: 'mac' })] },
        { text: 'GONE-SEEN' },
      ], 'and now?');
      const after = await waitForToolActivity(gone.sessionKey, (a) => a.results.length >= 1, 40_000);
      expect(after.results[0]?.text).toContain('not connected');
    } finally {
      daemon?.stop();
      events.close();
      rmSync(base, { recursive: true, force: true });
    }
  }, 240_000);

  it('only offers what the Mac declared: refuses an ungranted screen with how to fix it, follows a later grant, and turns away a Mac that declares nothing', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-mac-caps-')));
    const folder = join(base, 'Juno');
    mkdirSync(folder);
    const account = await createAccount('my-mac-caps');
    const daemons: LinkDaemon[] = [];
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Mac Looker' });
      expect(agent.status).toBe(201);

      // An app that does not declare what it can do (the installed 0.1.x one) never gets a link: the hub refuses it.
      const old = await pairAndConnect(account, folder, { device: null });
      daemons.push(old.daemon);
      expect((await account.api('GET', '/v1/computers/my-mac')).body).toMatchObject({ paired: true, online: false });
      old.daemon.stop();

      // The new app declares files and shell only: the desktop driver is not running yet.
      const cua: CuaClient = {
        call: async (tool) => tool === 'list_windows'
          ? { isError: false, json: { windows: [{ app_name: 'Notes', pid: 41, window_id: 7, title: 'n', is_on_screen: true }] } }
          : { isError: false, json: { snapshot_id: 's1', element_count: 1, tree_markdown: '- [0] AXWindow "n"' } },
      };
      const device = macDevice(['files', 'shell']);
      const linked = await pairAndConnect(account, folder, { device, cua });
      daemons.push(linked.daemon);
      expect((await account.api('GET', '/v1/computers/my-mac')).body).toMatchObject({ online: true, device: { actions: ['files', 'shell'] } });
      expect((await account.api('PATCH', `/v1/agents/${agent.body.id}`, { macAccess: true })).status).toBe(200);
      const events = await listenEvents(account.cookie);

      // The first use of an app asks; "Always allow" keeps it. The call is then refused because the Mac did not declare the desktop.
      const refused = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('s1', 'computer.snapshot', { app: 'Notes' })] },
        { text: 'SCREEN-REFUSED' },
      ], 'what is in my Notes?');
      const card = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.conversationId === refused.conversationId, 40_000);
      expect(card.data.request.payload.macApp).toMatchObject({ app: 'notes', purpose: 'use' });
      expect((await account.api('POST', `/v1/requests/${card.data.request.id}/resolve`, { action: 'approve', scope: 'app' })).status).toBe(200);
      const first = await waitForToolActivity(refused.sessionKey, (a) => a.results.length >= 1, 40_000);
      expect(first.results[0]).toMatchObject({ toolName: 'computer.snapshot', isError: true });
      expect(first.results[0]?.text).toContain('desktop driver');
      expect((await account.api('GET', '/v1/mac/apps')).body.apps).toMatchObject([{ app: 'notes', name: 'Notes' }]);

      // The desktop driver comes up: the app declares again and the next snapshot goes through without a card.
      device.actions = ['files', 'shell', 'desktop'];
      linked.daemon.redeclare();
      for (let attempt = 0; attempt < 100 && !((await account.api('GET', '/v1/computers/my-mac')).body.device?.actions ?? []).includes('desktop'); attempt += 1) await new Promise((r) => setTimeout(r, 100));
      const granted = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('s2', 'computer.snapshot', { app: 'Notes' })] },
        { text: 'SCREEN-SEEN' },
      ], 'and now?');
      const second = await waitForToolActivity(granted.sessionKey, (a) => a.results.length >= 1, 40_000);
      expect(second.results[0]).toMatchObject({ toolName: 'computer.snapshot', isError: false });
      expect(second.results[0]?.text).toContain('AXWindow');
      events.close();

      // Taking the app back makes the next use ask again.
      expect((await account.api('DELETE', '/v1/mac/apps/notes')).status).toBe(200);
      expect((await account.api('GET', '/v1/mac/apps')).body.apps).toEqual([]);
    } finally {
      for (const daemon of daemons) daemon.stop();
      rmSync(base, { recursive: true, force: true });
    }
  }, 240_000);

  it('Stop from a phone pauses the agent without an error, there is no remote resume, and resuming on the Mac lets it carry on', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-mac-stop-')));
    const folder = join(base, 'Juno');
    mkdirSync(folder);
    writeFileSync(join(folder, 'a.txt'), 'still here');
    const account = await createAccount('my-mac-stop');
    let daemon: LinkDaemon | undefined;
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Mac Stopper' });
      const linked = await pairAndConnect(account, folder);
      daemon = linked.daemon;
      expect((await account.api('PATCH', `/v1/agents/${agent.body.id}`, { macAccess: true })).status).toBe(200);
      expect((await account.api('GET', '/v1/computers/my-mac')).body.stopped).toBeUndefined();

      // Any client may Stop; the Mac hears it and says so.
      const stopped = await account.api('POST', '/v1/computers/my-mac/stop');
      expect(stopped.status).toBe(200);
      expect(stopped.body.stopped).toMatchObject({ epoch: 1 });
      for (let attempt = 0; attempt < 100 && !daemon.activity().stopped; attempt += 1) await new Promise((r) => setTimeout(r, 50));
      expect(daemon.activity().stopped).toBe(true);
      // Stopping twice is not another change.
      expect((await account.api('POST', '/v1/computers/my-mac/stop')).body.stopped).toMatchObject({ epoch: 1 });

      // A stopped Mac is a pause for the agent (a result, not an error), and nothing runs there.
      const paused = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('p1', 'files.read', { path: 'a.txt', on: 'mac' })] },
        { text: 'PAUSED-SEEN' },
      ], 'read it');
      const seen = await waitForToolActivity(paused.sessionKey, (a) => a.results.length >= 1, 40_000);
      expect(seen.results[0]).toMatchObject({ toolName: 'files.read', isError: false });
      expect(seen.results[0]?.text).toContain('Stopped by the user on the Mac');

      // Nothing on a phone can resume it; only the Mac itself can.
      expect((await account.api('POST', '/v1/computers/my-mac/resume')).status).toBe(404);
      daemon.resume();
      for (let attempt = 0; attempt < 100 && (await account.api('GET', '/v1/computers/my-mac')).body.stopped; attempt += 1) await new Promise((r) => setTimeout(r, 50));
      expect((await account.api('GET', '/v1/computers/my-mac')).body.stopped).toBeUndefined();
      const resumed = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('r1', 'files.read', { path: 'a.txt', on: 'mac' })] },
        { text: 'RESUMED-SEEN' },
      ], 'and now?');
      const after = await waitForToolActivity(resumed.sessionKey, (a) => a.results.length >= 1, 40_000);
      expect(after.results[0]).toMatchObject({ toolName: 'files.read', isError: false });
      expect(after.results[0]?.text).toContain('still here');
    } finally {
      daemon?.stop();
      rmSync(base, { recursive: true, force: true });
    }
  }, 240_000);
});

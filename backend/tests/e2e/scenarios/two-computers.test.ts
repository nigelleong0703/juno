import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startLinkDaemon, type LinkDaemon } from 'juno-link/daemon';
import { createAccount, listenEvents, macDevice, scriptedChat, toolCall, waitForToolActivity } from '../harness/client';

/**
 * Two computers: an agent with Mac access has its sandbox (here the fake one) and the owner's Mac (the real juno-link daemon
 * pointed at temp folders). It works in the sandbox, then `computer_copy` puts the result on the Mac: inside the shared folder
 * without a question, outside it only after the owner approves the card. An agent without Mac access is refused before anyone
 * is asked.
 */
describe('two computers', () => {
  it('copies from the sandbox to the Mac, asks for a path outside the Mac folder, and refuses an agent without Mac access', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-two-')));
    const folder = join(base, 'Juno');
    const outside = join(base, 'Documents');
    mkdirSync(folder);
    mkdirSync(outside);
    const account = await createAccount('two-computers');
    const events = await listenEvents(account.cookie);
    let daemon: LinkDaemon | undefined;
    try {
      const paired = await account.api('POST', '/v1/computers/my-mac', { name: 'Test Mac' });
      expect(paired.status).toBe(201);
      // The daemon shares the Juno folder and the Documents folder; the policy still asks about everything outside ~/Juno.
      daemon = startLinkDaemon({
        loadConfig: () => ({ url: paired.body.url, id: paired.body.id, token: paired.body.token }),
        roots: [folder, outside],
        scratchDir: join(base, 'scratch'),
        backoff: { minMs: 100, maxMs: 500 },
        device: () => macDevice(),
      });
      for (let attempt = 0; attempt < 100 && !(await account.api('GET', '/v1/computers/my-mac')).body.online; attempt += 1) await new Promise((r) => setTimeout(r, 100));

      const agent = await account.api('POST', '/v1/agents', { name: 'Two Computers' });
      expect(agent.status).toBe(201);
      expect(agent.body.macAccess).toBe(false);
      expect((await account.api('PATCH', `/v1/agents/${agent.body.id}`, { macAccess: true })).body.macAccess).toBe(true);

      const target = join(outside, 'report-copy.txt');
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('c1', 'shell.run', { command: 'echo build report' })] },
        { toolCalls: [toolCall('c2', 'files.write', { path: '/workspace/report.txt', content: 'quarterly numbers' })] },
        { toolCalls: [toolCall('c3', 'computer_copy', { from: 'sandbox', to: 'mac', path: '/workspace/report.txt' })] },
        { toolCalls: [toolCall('c4', 'computer_copy', { from: 'sandbox', to: 'mac', path: '/workspace/report.txt', toPath: target })] },
        { text: 'COPIED' },
      ], 'put the report on my Mac');

      const request = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.conversationId === conversationId, 40_000);
      // Everything before the second copy ran without a question: the first copy landed inside the shared folder.
      expect(readFileSync(join(folder, 'report.txt'), 'utf8')).toBe('quarterly numbers');
      expect(existsSync(target)).toBe(false);
      expect(request.data.request.status).toBe('pending');
      expect(JSON.stringify(request.data.request)).toContain('Mac');
      expect((await account.api('POST', `/v1/requests/${request.data.request.id}/resolve`, { action: 'approve' })).status).toBe(200);
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes('COPIED'), 40_000);
      expect(readFileSync(target, 'utf8')).toBe('quarterly numbers');

      const activity = await waitForToolActivity(sessionKey, (a) => a.results.length >= 4);
      expect(activity.results.map((r) => [r.toolName, r.isError])).toEqual([['shell.run', false], ['files.write', false], ['computer_copy', false], ['computer_copy', false]]);
      // The agent started the sandbox on its own (no "Set up computer"): the same flow recorded the owner's computer.
      const listed = await account.api('GET', '/v1/computers');
      expect(listed.body.items).toHaveLength(1);
      expect(listed.body.items[0].agentIds).toContain(agent.body.id);
      expect(activity.results[2]?.text).toContain('report.txt from the sandbox to your Mac');

      // Without Mac access the same call is refused outright, with the reason.
      const plain = await account.api('POST', '/v1/agents', { name: 'Sandbox Only' });
      const refused = await scriptedChat(account, plain.body.id, [
        { toolCalls: [toolCall('n1', 'computer_copy', { from: 'sandbox', to: 'mac', path: '/workspace/report.txt' })] },
        { text: 'REFUSED-SEEN' },
      ], 'copy it too');
      const seen = await waitForToolActivity(refused.sessionKey, (a) => a.results.length >= 1, 40_000);
      expect(seen.results[0]).toMatchObject({ toolName: 'computer_copy', isError: true });
      expect(seen.results[0]?.text).toContain('no access to your Mac');
    } finally {
      daemon?.stop();
      events.close();
      rmSync(base, { recursive: true, force: true });
    }
  }, 240_000);
});

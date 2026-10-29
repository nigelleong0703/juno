import { aguiInput } from '../../agui-input.js';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startLinkDaemon } from 'juno-link/daemon';
import { createAccount, listenEvents, macDevice, runReport, toolActivity } from '../harness/client';

/**
 * My Mac with a real model: an agent set to the Mac is asked to sort a folder by file type. The Mac is the real juno-link daemon
 * under Node, pointed at a temp folder. Every command the model runs raises an approval; the test plays the owner and approves
 * each one. Assertions check what happened (files moved, every shell command approved, nothing left loose), never wording.
 */
describe('real model: My Mac', () => {
  it('sorts a folder into folders by type, with every shell command approved', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-real-mac-')));
    const folder = join(base, 'Juno');
    const target = join(folder, 'test');
    mkdirSync(target, { recursive: true });
    const names = ['report.pdf', 'notes.txt', 'photo.jpg', 'budget.csv', 'logo.png', 'readme.md', 'slides.pdf', 'todo.txt'];
    for (const name of names) writeFileSync(join(target, name), `sample ${name}\n`);
    const account = await createAccount('real-my-mac');
    const events = await listenEvents(account.cookie);
    const daemon = (() => {
      const paired = account.api('POST', '/v1/computers/my-mac', { name: 'Real Mac' });
      return paired.then((result) => startLinkDaemon({ loadConfig: () => ({ url: result.body.url, id: result.body.id, token: result.body.token }), roots: [folder], scratchDir: join(base, 'scratch'), device: () => macDevice() }));
    })();
    let running: Awaited<typeof daemon> | undefined;
    try {
      running = await daemon;
      for (let attempt = 0; attempt < 100 && !(await account.api('GET', '/v1/computers/my-mac')).body.online; attempt += 1) await new Promise((r) => setTimeout(r, 100));
      const agent = await account.api('POST', '/v1/agents', { name: 'Sorter' });
      expect(agent.status).toBe(201);
      expect((await account.api('PATCH', `/v1/agents/${agent.body.id}`, { macAccess: true })).status).toBe(200);
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      const conversationId: string = created.body.id;
      const sessionKey = `${agent.body.id}:${conversationId}`;

      // The owner: approve every request of this chat as it appears.
      let approvals = 0;
      const approving = (async () => {
        const seen = new Set<string>();
        for (;;) {
          const event = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.conversationId === conversationId && !seen.has(e.data.request.id), 400_000);
          seen.add(event.data.request.id);
          expect((await account.api('POST', `/v1/requests/${event.data.request.id}/resolve`, { action: 'approve' })).status).toBe(200);
          approvals += 1;
        }
      })().catch(() => undefined);

      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, {
        text: 'Organise the files in the "test" folder of your working directory into folders by type (documents, images, text), moving each file into the right folder. Then reply with one short sentence.',
      }));
      expect(sent.status).toBe(202);
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId, 400_000);
      expect(finished.data.metadata.juno.run.status, await runReport(account, finished.data.metadata.juno.run.id)).toBe('completed');
      void approving;

      const activity = await toolActivity(sessionKey);
      const commands = activity.calls.filter((call) => call.name === 'shell.run' || call.name === 'shell.start');
      expect(commands.length, JSON.stringify(activity)).toBeGreaterThan(0);
      // Each command was approved first (the file tools inside the folder need no approval).
      expect(approvals, JSON.stringify(activity)).toBeGreaterThanOrEqual(commands.length);
      const loose = readdirSync(target, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
      expect(loose, `still loose: ${loose.join(', ')}; ${JSON.stringify(activity)}`).toEqual([]);
      const moved = readdirSync(target, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((dir) => readdirSync(join(target, dir.name)));
      expect(moved.sort(), JSON.stringify(activity)).toEqual([...names].sort());
      // The sandbox was never touched: no workspace path came back from the computer tools.
      expect(activity.results.some((result) => result.text.includes('/workspace')), JSON.stringify(activity)).toBe(false);
    } finally {
      running?.stop();
      events.close();
      if (existsSync(base)) rmSync(base, { recursive: true, force: true });
    }
  }, 480_000);
});

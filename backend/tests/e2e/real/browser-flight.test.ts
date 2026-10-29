import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createAccount, defaultAgent, listenEvents, runReport, transcriptMessages } from '../harness/client';

/**
 * Real model + real local computer (opt-in: E2E_COMPUTER_PROVIDER=local, image juno-desktop:local):
 * the 2026-10-12 slow flight check. With short refs the agent should drive the page through
 * browser.* refs instead of falling back to screenshots and pixel clicks. Prints the timing.
 */
describe.skipIf(process.env['E2E_COMPUTER_PROVIDER'] !== 'local')('real model + computer: flight check', () => {
  it('checks SIN to BKK flights through browser refs', async () => {
    // The local provider creates a container per new owner; remove the ones this test created.
    const containers = () => execFileSync('docker', ['ps', '-aq', '--filter', 'name=agent-local-'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    const before = new Set(containers());
    const account = await createAccount('real-flight');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await defaultAgent(account);
      // Like the user's Juno: a computer attached, so the browser tools exist.
      const computer = await account.api('POST', '/v1/computers/ensure', {});
      expect(computer.status, JSON.stringify(computer.body)).toBeLessThan(300);
      const screen = await account.api('POST', `/v1/computers/${computer.body.id}/screens`, { agentId: agent.id });
      expect(screen.status, JSON.stringify(screen.body)).toBeLessThan(300);
      const started = Date.now();
      const created = await account.api('POST', '/v1/conversations', {
        kind: 'direct', memberAgentIds: [agent.id], firstMessage: { text: 'help me check airplane ticket to bkk from sg, nov 6 to nov 9' },
      });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 900_000);
      const seconds = Math.round((Date.now() - started) / 1000);
      const runId: string = finished.data.metadata.juno.run.id;
      const steps = (await account.api('GET', `/v1/runs/${runId}/steps`)).body?.items ?? [];
      const tools: string[] = steps.map((s: { target?: string; verb?: string }) => String(s.target ?? s.verb));
      const count = (prefix: string) => tools.filter((t) => t.startsWith(prefix)).length;
      const reply = events.events.filter((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && e.data.item.type === 'agent_message').map((e) => String(e.data.item.markdown)).join('\n---\n');
      console.log(JSON.stringify({ seconds, status: finished.data.metadata.juno.run.status, steps: tools.length, browser: count('browser.'), computer: count('computer.'), tools }, null, 1));
      console.log('REPLY:\n' + reply.slice(0, 3000));
      // What the model saw and said, with times, to see where the seconds went.
      for (const m of await transcriptMessages(`${agent.id}:${conversationId}`)) console.log(`[${m.role}] ${m.text.slice(0, 700)}`);
      expect(finished.data.metadata.juno.run.status, await runReport(account, runId)).toBe('completed');
      // What the user sees: at most an opening line, then one result that carries real findings.
      const bubbles = events.events.filter((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && e.data.item.type === 'agent_message').map((e) => String(e.data.item.markdown));
      expect(bubbles.length, bubbles.join('\n---\n')).toBeGreaterThanOrEqual(1);
      expect(bubbles.length, bubbles.join('\n---\n')).toBeLessThanOrEqual(2);
      expect(bubbles.at(-1), 'final reply names fares or airlines').toMatch(/S\$\s?\d|SGD\s?\d|\d+\s?SGD|scoot|airasia|singapore airlines|thai|jetstar|lion/i);
    } finally {
      events.close();
      const created = containers().filter((id) => !before.has(id));
      if (created.length > 0) execFileSync('docker', ['rm', '-f', ...created]);
    }
  }, 960_000);
});

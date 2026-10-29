import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptModel } from '../harness/client';

/**
 * Routine fire (ported from the old b3 skipped scenario): a scheduled routine created through the
 * public API is armed durably, fires on its cron (seconds-level here, to keep the test short), wakes
 * the agent in its delivery chat as a routine run, and stops firing once toggled off. The final reply is
 * the one exit for a routine run like any other (H-17): a run with something to say posts it once, a run
 * whose final reply is blank posts nothing.
 */
describe('routine', () => {
  it('fires on schedule into its delivery chat as a routine run', async () => {
    const account = await createAccount('routine');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Digest' });
      expect(agent.status).toBe(201);
      const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      expect(chat.status).toBe(201);
      const conversationId: string = chat.body.id;
      const digest = `DIGEST-${randomUUID().slice(0, 8)}`;
      // First fire has nothing to say (a blank final reply), the next ones say the digest as their final reply.
      scriptModel(`${agent.body.id}:${conversationId}`, [{ text: '' }, { text: digest }, { text: digest }, { text: digest }]);

      const routine = await account.api('POST', '/v1/routines', {
        name: 'Every few seconds', agentId: agent.body.id, instructions: 'post the digest', enabled: true,
        trigger: { kind: 'schedule', cron: '*/5 * * * * *', human: 'every 5 seconds', tz: 'UTC' },
        delivery: { channel: 'chat', target: conversationId }, notify: { mode: 'never' },
      });
      expect(routine.status).toBe(201);

      const reply = await events.waitFor(
        (e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(digest),
        30_000,
      );
      const run = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === reply.data.item.runId, 30_000);
      expect(run.data.metadata.juno.run.kind).toBe('routine');
      expect(run.data.metadata.juno.run.status).toBe('completed');
      expect(String(run.data.metadata.juno.run.title)).toMatch(/^Routine:/);
      // The run that said the digest posted it exactly once, and the quiet run (a blank final reply) posted nothing.
      const mine = events.events.filter((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && e.data.item.runId === reply.data.item.runId);
      expect(mine.map((e) => String(e.data.item.markdown))).toEqual([digest]);
      const runs = events.events.filter((e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === conversationId).map((e) => String(e.data.metadata.juno.run.id));
      const quietRun = runs.find((id) => id !== reply.data.item.runId);
      if (quietRun !== undefined) {
        await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === quietRun, 30_000);
        expect(events.events.some((e) => e.data.type === 'item.added' && e.data.item.runId === quietRun)).toBe(false);
      }

      // H-76: the run shows up in the routine's history (it used to read an always-empty table).
      let history: Array<{ runId?: string; status: string }> = [];
      for (let i = 0; i < 20 && !history.some((h) => h.runId === run.data.metadata.juno.run.id); i += 1) {
        history = (await account.api('GET', `/v1/routines/${routine.body.id}/runs`)).body.items ?? [];
        if (!history.some((h) => h.runId === run.data.metadata.juno.run.id)) await new Promise((r) => setTimeout(r, 300));
      }
      expect(history.find((h) => h.runId === run.data.metadata.juno.run.id)?.status).toBe('completed');

      const off = await account.api('POST', `/v1/routines/${routine.body.id}/toggle`, { enabled: false });
      expect(off.status).toBeLessThan(300);
    } finally {
      events.close();
    }
  });

  it('pauses itself after five unread results and says so in the chat', async () => {
    const account = await createAccount('routine-pause');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Chatty' });
      const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      const conversationId: string = chat.body.id;
      scriptModel(`${agent.body.id}:${conversationId}`, Array.from({ length: 10 }, (_, i) => ({ text: 'update ' + String(i + 1) })));
      const routine = await account.api('POST', '/v1/routines', {
        name: 'Unread spam', agentId: agent.body.id, instructions: 'post an update', enabled: true,
        trigger: { kind: 'schedule', cron: '*/4 * * * * *', human: 'every 4 seconds', tz: 'UTC' },
        delivery: { channel: 'chat', target: conversationId }, notify: { mode: 'always' },
      });
      expect(routine.status).toBe(201);
      const paused = await events.waitFor((e) => e.data.type === 'routine.updated' && e.data.routine.id === routine.body.id && e.data.routine.status === 'paused', 80_000);
      expect(paused.data.routine.enabled).toBe(false);
      const stored = await account.api('GET', `/v1/routines/${routine.body.id}`);
      expect(stored.body.status).toBe('paused');
      // Nobody read the five results, so the routine stopped itself instead of posting forever.
      const runs = events.events.filter((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.kind === 'routine');
      expect(runs.length).toBeGreaterThanOrEqual(5);
      const notice = await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && e.data.item.type === 'system', 10_000);
      expect(String(notice.data.item.text).length).toBeGreaterThan(0);
    } finally {
      events.close();
    }
  }, 100_000);
});

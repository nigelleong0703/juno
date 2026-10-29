import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptModel } from '../harness/client';

/**
 * The quiet exit (BACKEND §3.3a): a routine run whose model calls `finish_quietly` completes with nothing delivered, even when it
 * also wrote text in the same turn. The delivery chat gets no item and no unread mark, and the routine's task says why in its result line.
 */
describe('quiet exit', () => {
  it('a routine run that finishes quietly posts nothing, leaves the chat read, and shows its reason as the task result', async () => {
    const account = await createAccount('quiet-exit');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'News' });
      expect(agent.status).toBe(201);
      const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      expect(chat.status).toBe(201);
      const conversationId: string = chat.body.id;
      const reason = `No new AI news since yesterday ${randomUUID().slice(0, 6)}`;
      const quiet = { text: '(empty)', toolCalls: [{ id: 'call-quiet', name: 'finish_quietly', arguments: { reason } }] };
      scriptModel(`${agent.body.id}:${conversationId}`, [quiet, quiet, quiet]);

      const routine = await account.api('POST', '/v1/routines', {
        name: 'AI news', agentId: agent.body.id, instructions: 'post AI news only when there is real news', enabled: true,
        trigger: { kind: 'schedule', cron: '*/5 * * * * *', human: 'every 5 seconds', tz: 'UTC' },
        delivery: { channel: 'chat', target: conversationId }, notify: { mode: 'always' },
      });
      expect(routine.status).toBe(201);

      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.kind === 'routine', 45_000);
      expect(finished.data.metadata.juno.run.status).toBe('completed');
      expect((await account.api('POST', `/v1/routines/${routine.body.id}/toggle`, { enabled: false })).status).toBeLessThan(300);

      // The task list says why there was nothing to tell.
      let line: string | undefined;
      for (let i = 0; i < 40 && line === undefined; i += 1) {
        const tasks = (await account.api('GET', '/v1/tasks?routineId=' + routine.body.id)).body.items as Array<{ status: string; outcome?: string; resultLine?: string }>;
        line = tasks.find((t) => t.status === 'ended')?.resultLine;
        if (line === undefined) await new Promise((r) => setTimeout(r, 250));
      }
      expect(line).toBe('Nothing to report: ' + reason);

      // Nothing reached the chat: no item of any kind, no unread mark, however many quiet runs fired.
      expect(events.events.some((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId)).toBe(false);
      const stored = await account.api('GET', `/v1/conversations/${conversationId}`);
      expect(stored.body.unreadCount).toBe(0);
      const items = await account.api('GET', `/v1/conversations/${conversationId}/items`);
      expect(items.body.items ?? []).toEqual([]);

      // A quiet run is a success: the routine is neither failed nor paused for unread results.
      const after = await account.api('GET', `/v1/routines/${routine.body.id}`);
      expect(after.body.status).not.toBe('failed');
    } finally {
      events.close();
    }
  });
});

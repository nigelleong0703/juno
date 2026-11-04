import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptModel, toolCall } from '../harness/client';

/**
 * Delivery split (BACKEND §3.3b): a routine run is one nobody waits on. Its final text is never a message: the delivery chat gets no item and
 * no unread mark, and the routine's task shows the text as its result line. The person is reached only by send_message (purpose result).
 */
describe('a routine run nobody waits on', () => {
  it('keeps its final text as the task result and posts nothing to the chat', async () => {
    const account = await createAccount('unattended-routine');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'News' });
      expect(agent.status).toBe(201);
      const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      expect(chat.status).toBe(201);
      const conversationId: string = chat.body.id;
      const record = `No new AI news since yesterday ${randomUUID().slice(0, 6)}`;
      scriptModel(`${agent.body.id}:${conversationId}`, [{ text: record }, { text: record }, { text: record }]);

      const routine = await account.api('POST', '/v1/routines', {
        name: 'AI news', agentId: agent.body.id, instructions: 'post AI news only when there is real news', enabled: true,
        trigger: { kind: 'schedule', cron: '*/5 * * * * *', human: 'every 5 seconds', tz: 'UTC' },
        delivery: { channel: 'chat', target: conversationId }, notify: { mode: 'always' },
      });
      expect(routine.status).toBe(201);

      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.kind === 'routine', 45_000);
      expect(finished.data.metadata.juno.run.status).toBe('completed');
      expect((await account.api('POST', `/v1/routines/${routine.body.id}/toggle`, { enabled: false })).status).toBeLessThan(300);

      let line: string | undefined;
      for (let i = 0; i < 40 && line === undefined; i += 1) {
        const tasks = (await account.api('GET', '/v1/tasks?routineId=' + routine.body.id)).body.items as Array<{ status: string; outcome?: string; resultLine?: string }>;
        line = tasks.find((t) => t.status === 'ended')?.resultLine;
        if (line === undefined) await new Promise((r) => setTimeout(r, 250));
      }
      expect(line).toBe(record);

      // Nothing reached the chat: no item of any kind, no unread mark, however many runs fired.
      expect(events.events.some((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId)).toBe(false);
      const stored = await account.api('GET', `/v1/conversations/${conversationId}`);
      expect(stored.body.unreadCount).toBe(0);
      const items = await account.api('GET', `/v1/conversations/${conversationId}/items`);
      expect(items.body.items ?? []).toEqual([]);

      const after = await account.api('GET', `/v1/routines/${routine.body.id}`);
      expect(after.body.status).not.toBe('failed');
    } finally {
      events.close();
    }
  });

  it('reaches the person with exactly one message when the run calls send_message, and the final text stays a record', async () => {
    const account = await createAccount('unattended-send');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'News' });
      expect(agent.status).toBe(201);
      const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      expect(chat.status).toBe(201);
      const conversationId: string = chat.body.id;
      const news = `Chip launch moved to Friday ${randomUUID().slice(0, 6)}`;
      const record = `Sent the news ${randomUUID().slice(0, 6)}`;
      scriptModel(`${agent.body.id}:${conversationId}`, [
        { toolCalls: [toolCall('call-news', 'send_message', { kind: 'text', purpose: 'result', text: news })] },
        { text: record },
      ]);
      const routine = await account.api('POST', '/v1/routines', {
        name: 'AI news', agentId: agent.body.id, instructions: 'post AI news only when there is real news', enabled: true,
        trigger: { kind: 'schedule', cron: '*/5 * * * * *', human: 'every 5 seconds', tz: 'UTC' },
        delivery: { channel: 'chat', target: conversationId }, notify: { mode: 'always' },
      });
      expect(routine.status).toBe(201);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.kind === 'routine', 45_000);
      expect((await account.api('POST', `/v1/routines/${routine.body.id}/toggle`, { enabled: false })).status).toBeLessThan(300);

      const items = (await account.api('GET', `/v1/conversations/${conversationId}/items`)).body.items as Array<{ type: string; markdown?: string }>;
      const said = items.filter((item) => item.type === 'agent_message').map((item) => item.markdown);
      expect(said).toContain(news);
      expect(said).not.toContain(record);
    } finally {
      events.close();
    }
  });
});

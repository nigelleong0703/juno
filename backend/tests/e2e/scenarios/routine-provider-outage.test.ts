import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { advanceClock, createAccount, listenEvents, listItems, queryStack, scriptModel, stackNow, toolCall } from '../harness/client';

/**
 * BACKEND §3.3d.3: a routine run that fails because the model provider rate-limits it (429, retry-after 600 s: too long to sleep through in
 * the run) is not lost and not counted. The same occurrence is sent again on a durable timer after the wait; the routine's failure streak and
 * auto-disable only ever count an occurrence's last attempt. The provider stub (scripted turn `fail`) answers 429 once, then works.
 */
describe('a routine fires while the model provider is rate-limited', () => {
  it('is sent again after the wait, succeeds once, and the routine keeps its record clean', async () => {
    const account = await createAccount('routine-outage');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'News' });
      expect(agent.status).toBe(201);
      const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      expect(chat.status).toBe(201);
      const conversationId: string = chat.body.id;
      const news = `Chip launch moved to Friday ${randomUUID().slice(0, 6)}`;
      scriptModel(`${agent.body.id}:${conversationId}`, [
        { fail: { retryAfterSeconds: 600 }, toolCalls: [toolCall('call-news', 'send_message', { kind: 'text', purpose: 'result', text: news })] },
        { text: 'Posted the news.' },
      ]);
      const routine = await account.api('POST', '/v1/routines', {
        name: 'AI news', agentId: agent.body.id, instructions: 'post AI news when there is real news', enabled: true,
        trigger: { kind: 'schedule', cron: '0 * * * *', human: 'every hour', tz: 'UTC' },
        delivery: { channel: 'chat', target: conversationId }, notify: { mode: 'always' },
      });
      expect(routine.status).toBe(201);

      // The routine must be armed (its next fire scheduled) before time moves, or the clock jump would move the schedule too.
      for (let i = 0; i < 80; i += 1) {
        if ((await account.api('GET', `/v1/routines/${routine.body.id}`)).body.nextRunAt !== undefined) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      // The next top of the hour arrives: the run starts, the provider says 429 with a ten-minute wait, and the run ends failed.
      await advanceClock(3_600_000 - (stackNow() % 3_600_000) + 30_000);
      await events.waitFor((e) => e.data.type === 'RUN_ERROR' && e.data.metadata.juno.run.conversationId === conversationId, 60_000);
      // The timer records the failure and schedules the re-fire a moment after the run ends.
      let pending: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 40 && pending.length === 0; i += 1) {
        pending = await queryStack("SELECT not_before FROM invocations WHERE service = 'RoutineTimer' AND handler = 'refire' AND key = ? AND status = 'pending'", [routine.body.id]);
        if (pending.length === 0) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(pending, 'one re-fire of the same occurrence is scheduled on a durable timer').toHaveLength(1);
      expect((await listItems(account, conversationId)).filter((item) => item.type === 'agent_message')).toEqual([]);

      // The wait passes: the occurrence is sent again under its own wake id, and this time the provider answers.
      await advanceClock(11 * 60_000);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 60_000);
      const said = (await listItems(account, conversationId)).filter((item) => item.type === 'agent_message').map((item) => item.markdown);
      expect(said).toEqual([news]);

      // The routine's own record is written by the timer a moment after the run ends.
      let stored = await account.api('GET', `/v1/routines/${routine.body.id}`);
      for (let i = 0; i < 40 && (stored.body.runs as unknown[]).length < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        stored = await account.api('GET', `/v1/routines/${routine.body.id}`);
      }
      expect(stored.body.enabled).toBe(true);
      expect(stored.body.status).not.toBe('failed');
      const history = (stored.body.runs as Array<{ status: string; summary: string }>).map((entry) => [entry.status, entry.summary.includes('AI provider was unavailable')]);
      expect(history).toEqual(expect.arrayContaining([['failed', true], ['completed', false]]));
      const wakes = await queryStack("SELECT count(*) AS n FROM invocations WHERE service = 'Session' AND handler = 'receive' AND key = ? AND input::text LIKE '%wake_routine_%'", [`${agent.body.id}:${conversationId}`]);
      expect(Number(wakes[0]?.['n'])).toBeGreaterThanOrEqual(2);
      await account.api('POST', `/v1/routines/${routine.body.id}/toggle`, { enabled: false });
    } finally {
      events.close();
    }
  }, 180_000);
});

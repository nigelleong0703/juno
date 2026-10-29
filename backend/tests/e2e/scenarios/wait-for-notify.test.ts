import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, request, scriptedChat, toolCall, transcriptTexts } from '../harness/client';

/**
 * H-69 (event): wait_for with notify:true lets the turn finish; a later matching webhook wakes the chat
 * once with a task_done carrying the event, and the agent reacts in the same chat.
 */
describe('wait_for notify', () => {
  it('finishes the turn, then is woken once by the matching webhook', async () => {
    const account = await createAccount('wait-notify');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Watcher' });
      expect(agent.status).toBe(201);
      const reacted = `CI-SEEN-${randomUUID().slice(0, 8)}`;
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-wait', 'wait_for', { filter: { source: 'ci' }, notify: true })] },
        { text: 'I will tell you when CI finishes.' },
        { text: reacted },
      ], 'tell me when CI is done');
      const firstRun = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 30_000);
      expect(firstRun.data.metadata.juno.run.status).toBe('completed');

      // A webhook routine delivering to this chat is the public entry for external events.
      const routine = await account.api('POST', '/v1/routines', {
        name: 'CI hook', agentId: agent.body.id, instructions: 'react to CI', enabled: true,
        trigger: { kind: 'webhook', url: 'pending', secretMasked: '' },
        delivery: { channel: 'chat', target: conversationId }, notify: { mode: 'never' },
      });
      expect(routine.status).toBe(201);
      const issued = await account.api('POST', `/v1/routines/${routine.body.id}/webhook`);
      expect(issued.status).toBe(200);
      // The external caller has no login session: the secret alone opens the hook.
      const event = { id: 'ci-' + randomUUID(), source: 'ci', type: 'build.done', data: { status: 'green' } };
      const hook = await request('POST', `/v1/hooks/${routine.body.id}`, event, undefined, { 'X-Hook-Secret': issued.body.secret });
      expect(hook.status).toBe(202);

      const reply = await events.waitFor(
        (e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(reacted),
        30_000,
      );
      expect(reply.data.item.type).toBe('agent_message');
      const transcript = await transcriptTexts(sessionKey);
      const completions = transcript.filter((t) => t.includes('[background task finished') && t.includes('kind=event'));
      expect(completions).toHaveLength(1);
      expect(completions[0]).toContain('build.done');
    } finally {
      events.close();
    }
  });

  it('is woken once with a timeout when no matching event arrives before expiry (H-85)', async () => {
    const account = await createAccount('wait-expiry');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Watcher' });
      expect(agent.status).toBe(201);
      const reacted = `EXPIRED-SEEN-${randomUUID().slice(0, 8)}`;
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-wait', 'wait_for', { filter: { source: 'never' }, notify: true, timeout: '+5s' })] },
        { text: 'Watching for it.' },
        { text: reacted },
      ], 'tell me if the deploy hook fires');
      const reply = await events.waitFor(
        (e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(reacted),
        45_000,
      );
      expect(reply.data.item.type).toBe('agent_message');
      const transcript = await transcriptTexts(sessionKey);
      const timeouts = transcript.filter((t) => t.includes('[background task finished') && t.includes('kind=event status=timeout'));
      expect(timeouts).toHaveLength(1);
    } finally {
      events.close();
    }
  });
});

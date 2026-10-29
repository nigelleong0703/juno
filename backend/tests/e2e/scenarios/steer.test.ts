import { aguiInput } from '../../agui-input.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptedChat, toolCall, transcriptMessages } from '../harness/client';

/**
 * Steering (ported from the old b2 skipped scenario): a message sent while the agent's run is busy is
 * handed to that same run at its next boundary instead of starting a second run, so the agent's reply
 * accounts for both messages.
 */
describe('steer into an active run', () => {
  it('folds a message sent mid-run into the same run', async () => {
    const account = await createAccount('steer');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Busy' });
      expect(agent.status).toBe(201);
      const reply = `STEERED-${randomUUID().slice(0, 8)}`;
      const followUp = `also check Penang ${randomUUID().slice(0, 4)}`;
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-wait', 'wake_at', { when: '+8s' })] },
        { text: reply },
      ], 'compare KL fares');
      const waiting = await events.waitFor((e) => e.data.type === 'STEP_FINISHED' && e.data.metadata.juno.step?.target === 'wake_at', 30_000);
      const runId: string = waiting.data.metadata.juno.runId;

      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: followUp }));
      expect(sent.status).toBe(202);

      const answered = await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(reply), 45_000);
      expect(answered.data.item.runId).toBe(runId);
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === runId, 30_000);
      expect(finished.data.metadata.juno.run.status).toBe('completed');
      // One run handled both messages, and the follow-up reached the model before its reply.
      const started = events.events.filter((e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === conversationId);
      expect(started).toHaveLength(1);
      const transcript = await transcriptMessages(sessionKey);
      const followAt = transcript.findIndex((m) => m.role === 'user' && m.text.includes(followUp));
      const replyAt = transcript.findIndex((m) => m.role === 'assistant' && m.text.includes(reply));
      expect(followAt).toBeGreaterThan(-1);
      expect(replyAt).toBeGreaterThan(followAt);
    } finally {
      events.close();
    }
  });
});

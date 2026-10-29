import { aguiInput } from '../../agui-input.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { childSessionKey, createAccount, listenEvents, scriptModel, toolActivity, toolCall, transcriptMessages, waitForToolActivity } from '../harness/client';

/**
 * child_message to a RUNNING child: the follow-up is a steer into the same child run. The child sleeps in a
 * steerable wake_at, the parent (which is sleeping too) is woken by an owner message once the child's id is known and sends it, and
 * the child reads it at its next boundary and replies within that one run. Child ids only exist after the
 * spawn ran, so the parent's script is extended from the transcript while its own sleep is still going.
 */
describe('child_message to a running child', () => {
  it('steers the same child run instead of starting a new one', async () => {
    const account = await createAccount('child-steer');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Lead' });
      expect(agent.status).toBe(201);
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      const sessionKey = `${agent.body.id}:${conversationId}`;
      const reply = `STEER-REPLY-${randomUUID().slice(0, 8)}`;
      const steer = `also cover Penang ${randomUUID().slice(0, 4)}`;
      // The child sleeps well past the parent's own sleep, so it is still running when the message lands.
      scriptModel(`${sessionKey}::child:*`, [
        { toolCalls: [toolCall('call-sleep', 'wake_at', { when: '+60s', reason: 'gather fares' })] },
        { text: reply },
      ]);
      scriptModel(sessionKey, [
        { toolCalls: [toolCall('call-spawn', 'child_spawn', { prompt: 'gather fares', notify: true })] },
        { toolCalls: [toolCall('call-hold', 'wake_at', { when: '+30s', reason: 'let fares come in' })] },
        { text: 'gathering fares' },
      ]);
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'get me fares' }))).status).toBe(202);
      const spawn = (await waitForToolActivity(sessionKey, (a) => a.results.some((r) => r.toolName === 'child_spawn'))).results.find((r) => r.toolName === 'child_spawn');
      const childRunId = /Spawned child task (\S+)/.exec(spawn?.text ?? '')?.[1];
      expect(childRunId).toBeDefined();

      scriptModel(sessionKey, [
        { toolCalls: [toolCall('call-spawn', 'child_spawn', { prompt: 'gather fares', notify: true })] },
        { toolCalls: [toolCall('call-hold', 'wake_at', { when: '+30s', reason: 'let fares come in' })] },
        { toolCalls: [toolCall('call-msg', 'child_message', { runId: childRunId, text: steer })] },
        { text: 'sent your note' },
        { text: 'the child is done' },
      ]);
      // The sleeping parent is steerable: a message from the owner wakes it now, so nothing waits for its 30 s deadline.
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'tell the child about Penang' }))).status).toBe(202);
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === childRunId, 60_000);
      expect(finished.data.metadata.juno.run.status).toBe('completed');

      const activity = await toolActivity(sessionKey);
      expect(activity.results.find((r) => r.toolName === 'child_message')?.text).toContain('Message queued for running child');
      // No continuation run: the only child run in this chat is the one that was already running.
      const childStarts = events.events.filter((e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.parentRunId !== undefined);
      expect(childStarts.map((e) => e.data.metadata.juno.run.id)).toEqual([childRunId]);
      // The steer reached the child's own transcript before its reply, in the same run.
      const childMessages = await transcriptMessages(childSessionKey(agent.body.id, conversationId, childRunId ?? ''));
      const steerAt = childMessages.findIndex((m) => m.role === 'user' && m.text.includes(steer));
      const replyAt = childMessages.findIndex((m) => m.role === 'assistant' && m.text.includes(reply));
      expect(steerAt).toBeGreaterThan(-1);
      expect(replyAt).toBeGreaterThan(steerAt);
    } finally {
      events.close();
    }
  });
});

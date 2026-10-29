import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptedChat, toolCall } from '../harness/client';

/**
 * Approval pause and resume (ported from the old b2 skipped scenario): an "ask" rule on a tool makes
 * the run pause with a pending request instead of running it; approving the request through the
 * public API resumes the same run, which runs the tool and finishes with the agent's reply.
 */
describe('tool approval', () => {
  it('pauses on an ask rule and resumes the same run after approval', async () => {
    const account = await createAccount('approval');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Careful' });
      expect(agent.status).toBe(201);
      const rule = await account.api('POST', '/v1/rules', {
        description: 'Ask before listing agents', scope: 'action', behavior: 'ask', subject: 'agent_directory', enabled: true,
      });
      expect(rule.status).toBeLessThan(300);
      const done = `APPROVED-${randomUUID().slice(0, 8)}`;
      const { conversationId } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-dir', 'agent_directory')] },
        { text: done },
      ], 'who else is on the team?');

      const created = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.conversationId === conversationId, 30_000);
      const requestId: string = created.data.request.id;
      expect(created.data.request.status).toBe('pending');
      const runId: string = created.data.request.runId;
      // Paused: no reply yet, the run is waiting for input.
      expect(events.events.some((e) => e.data.type === 'item.added' && String(e.data.item?.markdown).includes(done))).toBe(false);

      const resolved = await account.api('POST', `/v1/requests/${requestId}/resolve`, { action: 'approve' });
      expect(resolved.status).toBe(200);
      const reply = await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(done), 30_000);
      expect(reply.data.item.runId).toBe(runId);
      // The approval pause ended a wire segment with an interrupt outcome (not a durable run end); the run's
      // final segment is the RUN_FINISHED with a success outcome.
      const paused = events.events.find((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === runId);
      expect(paused?.data.outcome).toMatchObject({ type: 'interrupt', interrupts: [{ id: requestId }] });
      expect(paused?.data.metadata.juno.run.status).toBe('waiting_for_input');
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.outcome?.type === 'success' && e.data.metadata.juno.run.id === runId, 30_000);
      expect(finished.data.metadata.juno.run.status).toBe('completed');
      const step = (finished.data.metadata.juno.run.steps ?? []).find((s: { target?: string }) => s.target === 'agent_directory');
      expect(step?.status).toBe('completed');
    } catch (error) {
      for (const e of events.events) if (['request.created', 'item.added', 'RUN_FINISHED'].includes(e.data.type)) console.error('[e2e]', e.data.type, JSON.stringify(e.data.request ?? e.data.item ?? e.data.metadata.juno.run).slice(0, 260));
      throw error;
    } finally {
      events.close();
    }
  });
});

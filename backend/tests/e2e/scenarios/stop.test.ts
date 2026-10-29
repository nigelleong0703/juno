import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, insertDocRow, listenEvents, scriptedChat, toolCall } from '../harness/client';

/**
 * Stop (ported from the old b2 skipped scenario; H-79): stopping a run that sits in a short in-run wait
 * only requests the stop; the run itself finalizes as stopped (one run.finished), and nothing it would
 * have said afterwards is posted.
 */
describe('stop a run', () => {
  it('stops a waiting run for real and posts nothing afterwards', async () => {
    const account = await createAccount('stop');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Sleeper' });
      expect(agent.status).toBe(201);
      const never = `NEVER-${randomUUID().slice(0, 8)}`;
      const { conversationId } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-wait', 'wake_at', { when: '+30s' })] },
        { text: never },
      ], 'wait half a minute then say something');
      const step = await events.waitFor((e) => e.data.type === 'STEP_FINISHED' && e.data.metadata.juno.step?.target === 'wake_at', 30_000);
      const runId: string = step.data.metadata.juno.runId;

      const stop = await account.api('POST', `/v1/runs/${runId}/stop`);
      expect(stop.status).toBe(202);
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === runId, 30_000);
      expect(finished.data.metadata.juno.run.status).toBe('stopped');

      // A second stop on the finished run changes nothing.
      const again = await account.api('POST', `/v1/runs/${runId}/stop`);
      expect(again.status).toBe(200);
      expect(again.body.status).toBe('stopped');
      // Exactly one run.finished, and the scripted follow-up never appears.
      await new Promise((r) => setTimeout(r, 2_000));
      expect(events.events.filter((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === runId)).toHaveLength(1);
      expect(events.events.some((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item?.markdown).includes(never))).toBe(false);
    } finally {
      events.close();
    }
  });

  it('clears an orphaned running row that has no workflow behind it', async () => {
    const account = await createAccount('stop-orphan');
    const agent = await account.api('POST', '/v1/agents', { name: 'Ghost' });
    const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
    const at = new Date().toISOString();
    const id = 'run_orphan_' + randomUUID().slice(0, 8);
    await insertDocRow('runs', account.userId, {
      id, agentId: agent.body.id, conversationId: chat.body.id, title: 'stuck', status: 'running', kind: 'chat', steps: [],
      usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: at, lastActivityAt: at,
    }, { agentId: agent.body.id, conversationId: chat.body.id, status: 'running', kind: 'chat' });
    const stop = await account.api('POST', `/v1/runs/${id}/stop`);
    expect(stop.status).toBeLessThan(300);
    // Whatever path it takes, the stuck row must end stopped.
    let status = '';
    for (let i = 0; i < 20 && status !== 'stopped'; i += 1) {
      status = (await account.api('GET', `/v1/runs/${id}`)).body.status;
      if (status !== 'stopped') await new Promise((r) => setTimeout(r, 500));
    }
    expect(status).toBe('stopped');
  });
});

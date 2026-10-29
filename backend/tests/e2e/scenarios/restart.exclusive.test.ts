import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, execStack, listenEvents, queryStack, restartAgentd, scriptedChat, toolCall } from '../harness/client';

/**
 * Durability (ported from the old b2/b3 skipped scenarios): agentd is killed hard (SIGKILL) while a
 * run sleeps after a side effect. On restart the durable runner re-runs the run from its saved steps: the side-effecting tool
 * (shell.start, replay:never) is not executed again, the sleep resumes, and the agent replies once.
 */
/**
 * Exclusive: these scenarios SIGKILL agentd, so they run alone after the parallel group (vitest.config.ts). They stay in order
 * in this one file: the crash-resume scenario must run before the one that leaves a poisoned run behind.
 */
describe('restart', () => {
  it('resumes a sleeping run after a crash without repeating its side effect', async () => {
    const account = await createAccount('restart');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Durable' });
      expect(agent.status).toBe(201);
      const ensured = await account.api('POST', '/v1/computers/ensure', { agentId: agent.body.id });
      expect(ensured.status).toBeLessThan(300);
      const marker = `RESUMED-${randomUUID().slice(0, 8)}`;
      const { conversationId } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-start', 'shell.start', { command: 'fake:exit 0 after 1' })] },
        { toolCalls: [toolCall('call-wait', 'wake_at', { when: '+6s' })] },
        { text: marker },
      ], 'start it, wait a bit, then report');
      const sleeping = await events.waitFor((e) => e.data.type === 'STEP_FINISHED' && e.data.metadata.juno.step?.target === 'wake_at', 30_000);
      const runId: string = sleeping.data.metadata.juno.runId;

      await restartAgentd();
      // The SSE stream is proxied to agentd and drops with it; read durable state through the API.
      let replyRunId: string | undefined;
      for (let i = 0; i < 90 && replyRunId === undefined; i += 1) {
        const items = await account.api('GET', `/v1/conversations/${conversationId}/items`);
        const hit = (items.body.items ?? []).find((it: { type: string; markdown?: string }) => it.type === 'agent_message' && String(it.markdown).includes(marker));
        replyRunId = hit?.runId;
        if (replyRunId === undefined) await new Promise((r) => setTimeout(r, 500));
      }
      if (replyRunId === undefined) {
        const now = await account.api('GET', `/v1/runs/${runId}`);
        throw new Error('no reply after restart; run status ' + String(now.body.status) + ' steps ' + JSON.stringify((now.body.steps ?? []).map((s: { target?: string; status?: string }) => s.target + ':' + s.status)));
      }
      expect(replyRunId).toBe(runId);
      const run = await account.api('GET', `/v1/runs/${runId}`);
      // Give the replayed run a moment to finalize, then check it once.
      let status = run.body.status;
      for (let i = 0; i < 20 && status !== 'completed'; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        status = (await account.api('GET', `/v1/runs/${runId}`)).body.status;
      }
      expect(status).toBe('completed');
      const steps: Array<{ target?: string }> = (await account.api('GET', `/v1/runs/${runId}`)).body.steps ?? [];
      expect(steps.filter((s) => s.target === 'shell.start')).toHaveLength(1);
      expect(steps.filter((s) => s.target === 'wake_at')).toHaveLength(1);
      const items = await account.api('GET', `/v1/conversations/${conversationId}/items`);
      expect((items.body.items ?? []).filter((it: { markdown?: string }) => String(it.markdown).includes(marker))).toHaveLength(1);
    } finally {
      events.close();
    }
  }, 120_000);

  it('ends a run whose workflow used up its retries as failed with a reason, and a stop after that changes nothing', async () => {
    const account = await createAccount('stop-exhausted');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Frozen' });
      const { conversationId } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-wait', 'wake_at', { when: '+60s' })] },
        { text: 'never' },
      ], 'wait a minute');
      const step = await events.waitFor((e) => e.data.type === 'STEP_FINISHED' && e.data.metadata.juno.step?.target === 'wake_at', 30_000);
      const runId: string = step.data.metadata.juno.runId;
      // Damage the run's first saved step, then crash agentd: every replay fails, so the runner retries and gives up.
      const [invocation] = await queryStack("SELECT id FROM invocations WHERE service = 'Run' AND key = ? AND handler = 'run'", [runId]);
      expect(invocation?.['id']).toBeTruthy();
      await execStack("UPDATE journal SET result = '{broken' WHERE invocation_id = ? AND seq = 0", [String(invocation?.['id'])]);
      await restartAgentd();

      let run: { status: string; error?: string } = { status: '' };
      for (let i = 0; i < 120 && run.status !== 'failed'; i += 1) {
        run = (await account.api('GET', `/v1/runs/${runId}`)).body;
        if (run.status !== 'failed') await new Promise((r) => setTimeout(r, 500));
      }
      expect(run.status).toBe('failed');
      expect(run.error).toMatch(/repeated internal errors/);

      const stop = await account.api('POST', `/v1/runs/${runId}/stop`);
      expect(stop.status).toBe(200);
      expect(stop.body.status).toBe('failed');
      expect(events.events.some((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item?.markdown) === 'never')).toBe(false);
    } finally {
      events.close();
    }
  });
});

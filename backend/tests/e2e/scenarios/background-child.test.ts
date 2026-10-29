import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptedChat, toolCall, transcriptMessages } from '../harness/client';

/** Poll the parent transcript until the agent has spoken (an assistant text turn) after the completion. */
async function waitForReplyAfterCompletion(sessionKey: string, childRunId: string): Promise<Array<{ role: string; text: string }>> {
  const end = Date.now() + 45_000;
  let last: Array<{ role: string; text: string }> = [];
  while (Date.now() < end) {
    last = await transcriptMessages(sessionKey);
    const at = last.findIndex((m) => m.text.includes('[background task finished') && m.text.includes('id=' + childRunId));
    if (at >= 0 && last.slice(at + 1).some((m) => m.role === 'assistant' && m.text.includes('"type":"text"'))) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('no agent reply after the completion; transcript: ' + JSON.stringify(last).slice(0, 1500));
}

/**
 * H-69/H-70: the agent spawns a background child (notify) and is not held waiting for it (no child_wait,
 * no child gate). When the child ends, exactly one task_done reaches the spawning session as a result,
 * and the agent speaks again after it. Timing decides how: if the parent run is still going, the
 * completion is steered into it; if it already finished, the completion wakes a new background run.
 * Both are correct, so the test checks the transcript order instead of which scripted line answered.
 */
describe('background child task', () => {
  it('is not held by the child, then receives its completion once and responds after it', async () => {
    const account = await createAccount('bg-child');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Planner' });
      expect(agent.status).toBe(201);
      const ack = `BG-ACK-${randomUUID().slice(0, 8)}`;
      const report = `BG-REPORT-${randomUUID().slice(0, 8)}`;
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-spawn', 'child_spawn', { prompt: 'look up fares', notify: true })] },
        { text: ack },
        { text: report },
      ], 'find me fares');

      const child = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.kind === 'background' && String(e.data.metadata.juno.run.title) === 'look up fares', 45_000);
      expect(child.data.metadata.juno.run.status).toBe('completed');

      const transcript = (await waitForReplyAfterCompletion(sessionKey, child.data.metadata.juno.run.id)).map((m) => m.text);
      const completions = transcript.filter((t) => t.includes('[background task finished') && t.includes('id=' + child.data.metadata.juno.run.id));
      expect(completions).toHaveLength(1);
      expect(completions[0]).toContain('kind=child status=completed');
      expect(transcript.some((m) => m.includes('[internal child check]'))).toBe(false);
      // Every parent run in this chat finished completed and none waited on the child.
      const parentRuns = events.events.filter((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.id !== child.data.metadata.juno.run.id);
      expect(parentRuns.length).toBeGreaterThan(0);
      for (const run of parentRuns) {
        expect(run.data.metadata.juno.run.status).toBe('completed');
        expect(JSON.stringify(run.data.metadata.juno.run.steps ?? [])).not.toContain('child_wait');
      }
    } finally {
      events.close();
    }
  });
});

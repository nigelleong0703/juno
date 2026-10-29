import { aguiInput } from '../../agui-input.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { childSessionKey, createAccount, listenEvents, scriptModel, toolActivity, toolCall, transcriptTexts, waitForToolActivity, waitForTranscript } from '../harness/client';

/**
 * child_message to a FINISHED background child, the main follow-up flow: the agent spawns a background child
 * and ends its turn; the child finishes and its task_done wakes the agent into a NEW run, which messages the
 * finished child. The continuation starts on a copy of the child's transcript (so it sees the first draft plus
 * the new message), and its result comes back to the woken run. The child sleeps 6 seconds before its draft so
 * the scripted parent can be extended with the child's id while its first turn is over and before the wake.
 */
describe('child_message to a finished child', () => {
  it('a woken parent run continues a finished background child and collects the new result', async () => {
    const account = await createAccount('child-continue');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Writer' });
      expect(agent.status).toBe(201);
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      const sessionKey = `${agent.body.id}:${conversationId}`;
      const first = `FIRST-DRAFT-${randomUUID().slice(0, 8)}`;
      const expanded = `EXPANDED-${randomUUID().slice(0, 8)}`;
      // Child turns are indexed by its own transcript: the continuation starts after the first draft and takes the last line.
      scriptModel(`${sessionKey}::child:*`, [
        { toolCalls: [toolCall('call-sleep', 'wake_at', { when: '+6s', reason: 'draft the note' })] },
        { text: first },
        { text: expanded },
      ]);
      const spawnTurns = [
        { toolCalls: [toolCall('call-spawn', 'child_spawn', { prompt: 'draft the note', notify: true })] },
        { text: 'drafting it; I will tell you when it is ready' },
      ];
      scriptModel(sessionKey, spawnTurns);
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'draft a note' }))).status).toBe(202);
      const spawner = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.parentRunId === undefined, 30_000);
      const spawn = (await waitForToolActivity(sessionKey, (a) => a.results.some((r) => r.toolName === 'child_spawn'))).results.find((r) => r.toolName === 'child_spawn');
      const childRunId = /Spawned child task (\S+)/.exec(spawn?.text ?? '')?.[1];
      expect(childRunId).toBeDefined();

      // The woken run is the next root run; its first model call is the child_message below.
      const follow = 'now expand it with dates';
      scriptModel(sessionKey, [
        ...spawnTurns,
        { toolCalls: [toolCall('call-read', 'child_results', { runId: childRunId })] },
        { toolCalls: [toolCall('call-msg', 'child_message', { runId: childRunId, text: follow })] },
        { toolCalls: [toolCall('call-wait', 'child_wait')] },
        { text: 'expanded note is ready' },
      ]);
      const draft = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === childRunId, 60_000);
      expect(draft.data.metadata.juno.run.status).toBe('completed');
      const woken = await events.waitFor((e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.parentRunId === undefined && e.data.metadata.juno.run.id !== spawner.data.metadata.juno.run.id, 30_000);

      // The continued result reaches the woken run: in the child_wait result, or as an internal message if the wait suspended.
      await waitForTranscript(sessionKey, (m) => m.some((t) => t.includes(expanded)), 90_000);
      const activity = await toolActivity(sessionKey);
      const continued = activity.results.find((r) => r.toolName === 'child_message');
      const continuedRunId = /as run (\S+) \(/.exec(continued?.text ?? '')?.[1];
      expect(continuedRunId).toBeDefined();
      expect(continuedRunId).not.toBe(childRunId);
      // The woken run may read the child its earlier run spawned (the same ownership rule as child_message).
      expect(activity.results.find((r) => r.toolName === 'child_results')?.isError).toBe(false);
      const continuation = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === continuedRunId, 45_000);
      expect(continuation.data.metadata.juno.run.status).toBe('completed');
      expect(woken.data.metadata.juno.run.id).not.toBe(spawner.data.metadata.juno.run.id);

      // The continuation's context is the earlier child transcript, then the new message.
      const childTranscript = await transcriptTexts(childSessionKey(agent.body.id, conversationId, continuedRunId ?? ''));
      const draftAt = childTranscript.findIndex((t) => t.includes(first));
      const followAt = childTranscript.findIndex((t) => t.includes(follow));
      expect(draftAt).toBeGreaterThan(-1);
      expect(followAt).toBeGreaterThan(draftAt);
    } finally {
      events.close();
    }
  }, 150_000);
});

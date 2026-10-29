import { describe, expect, it } from 'vitest';
import { EventType, type AgentEvent } from '@agent-desktop/public-contracts';
import { createAccount, listenEvents, scriptedChat, toolCall, transcriptTexts } from '../harness/client';

/**
 * Operator-style takeover: the user takes the agent's screen mid-run and hands it back. The run is steered
 * (not ended) with a system note at each step and continues, in the same single run, with the hand-back note.
 */
describe('screen takeover and hand-back', () => {
  it('pauses a live run with a note and continues it when control returns', async () => {
    const account = await createAccount('screen-control');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Joker' });
      expect(agent.status).toBe(201);
      const ensured = await account.api('POST', '/v1/computers/ensure', { agentId: agent.body.id });
      expect(ensured.status).toBeLessThan(300);
      const screenId: string = ensured.body.screens[0].id;
      const reply = `CONTINUED-${Date.now()}`;
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-wait-1', 'wake_at', { when: '+60s' })] },
        { toolCalls: [toolCall('call-wait-2', 'wake_at', { when: '+60s' })] },
        { text: reply },
      ], 'open the page and keep going');
      const isWait = (e: { data: AgentEvent }) => e.data.type === EventType.STEP_FINISHED && e.data.metadata?.juno?.step?.target === 'wake_at';
      await events.waitFor((e) => isWait(e), 30_000);

      expect((await account.api('POST', `/v1/screens/${screenId}/take-over`)).status).toBe(200);
      // The first wait ends early on the takeover note; the model sleeps again, still in the same run.
      await events.waitFor((e) => events.events.filter(isWait).length >= 2 && isWait(e), 30_000);
      expect((await account.api('POST', `/v1/screens/${screenId}/return-control`)).status).toBe(200);

      const answered = await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(reply), 45_000);
      const runs = events.events.filter((e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === conversationId);
      expect(runs).toHaveLength(1);
      expect(answered.data.item.runId).toBe(runs[0]!.data.metadata.juno.run.id);

      const transcript = await transcriptTexts(sessionKey);
      const taken = transcript.findIndex((t) => t.includes('The user has taken control of your screen'));
      const back = transcript.findIndex((t) => t.includes('handed it back'));
      const done = transcript.findIndex((t) => t.includes(reply));
      expect(taken).toBeGreaterThan(-1);
      expect(back).toBeGreaterThan(taken);
      expect(done).toBeGreaterThan(back);
      expect(transcript[back]).toContain('take a fresh screenshot or snapshot before acting');
    } finally {
      events.close();
    }
  });
});

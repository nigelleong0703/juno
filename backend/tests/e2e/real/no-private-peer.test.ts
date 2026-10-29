import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, listRuns, runReport, toolActivity } from '../harness/client';

/**
 * Agents may not talk to each other outside a room the user is in: message_agent from a direct chat
 * is refused, nothing is queued, no peer conversation exists and the other agent never runs.
 */
describe('real model: no private agent-to-agent chat', () => {
  it('refuses message_agent from a direct chat', async () => {
    const account = await createAccount('real-no-peer');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Lead' });
      const other = await account.api('POST', '/v1/agents', { name: 'Peer' });
      expect(agent.status).toBe(201);
      expect(other.status).toBe(201);
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      const conversationId: string = created.body.id;
      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, {
        text:
          `Call the message_agent tool exactly once with target "${other.body.id}" and message "hello from Lead". ` +
          'If it fails, do not try any other way to reach that agent: just tell me in one sentence what happened.',
      }));
      expect(sent.status).toBe(202);
      const started = await events.waitFor((e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === conversationId, 60_000);
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === started.data.metadata.juno.run.id, 200_000);
      expect(finished.data.metadata.juno.run.status, await runReport(account, finished.data.metadata.juno.run.id)).toBe('completed');

      const activity = await toolActivity(`${agent.body.id}:${conversationId}`);
      expect(activity.calls.some((call) => call.name === 'message_agent')).toBe(true);
      const attempts = activity.results.filter((r) => r.toolName === 'message_agent');
      expect(attempts.length).toBeGreaterThanOrEqual(1);
      for (const attempt of attempts) expect(attempt.isError).toBe(true);

      const conversations = await account.api('GET', '/v1/conversations?limit=100');
      // Creating an agent opens its own direct chat (it greets there); the refused message opened no other chat, and never a peer one.
      expect(conversations.body.items.every((c: { kind: string }) => c.kind === 'direct')).toBe(true);
      expect(conversations.body.items.some((c: { kind: string }) => c.kind === 'peer')).toBe(false);
      // The other agent ran only its own greeting, nothing the first agent sent.
      const otherRuns = await account.api('GET', `/v1/runs?agentId=${other.body.id}&limit=50`);
      expect(otherRuns.body.items.filter((run: { title: string }) => run.title !== 'Getting started')).toHaveLength(0);
      expect((await listRuns(account, conversationId)).every((run) => run.agentId === agent.body.id)).toBe(true);
    } finally {
      events.close();
    }
  });
});

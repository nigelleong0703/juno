import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, runReport } from '../harness/client';

/**
 * Persona with a real model (owner report 2026-10-21): asked to change its personality, the agent writes it to its
 * IDENTITY.md (the Persona field the owner sees), not only the card subtitle, and the next reply speaks in it.
 * Checks the stored file and one marker word the persona asks for, never wording otherwise.
 */
describe('real model: persona', () => {
  it('writes a requested personality to IDENTITY.md and replies in it', async () => {
    const account = await createAccount('real-persona');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Tavi' });
      expect(agent.status).toBe(201);
      const agentId: string = agent.body.id;
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agentId] });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      const seenRuns = new Set<string>();

      /** Send one message, wait for its run (approving any request it raises), return the run's reply text. */
      const ask = async (text: string): Promise<string> => {
        const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }));
        expect(sent.status).toBe(202);
        const waiting = events.waitFor(
          (e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId && !seenRuns.has(e.data.metadata.juno.run.id),
          240_000,
        );
        // Changing an agent asks the owner first: approve whatever the run raises, as the owner would.
        let done = false;
        const approving = (async () => {
          while (!done) {
            const pending = await account.api('GET', `/v1/requests?agentId=${agentId}&status=pending&kind=approval`);
            for (const request of (pending.body.items ?? []) as Array<{ id: string }>) await account.api('POST', `/v1/requests/${request.id}/resolve`, { action: 'approve' });
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
        })();
        const finished = await waiting.finally(() => { done = true; });
        await approving;
        const runId: string = finished.data.metadata.juno.run.id;
        seenRuns.add(runId);
        expect(finished.data.metadata.juno.run.status, await runReport(account, runId)).toBe('completed');
        const items = await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`);
        return (items.body.items as Array<{ type: string; runId?: string; markdown?: string }>)
          .filter((item) => item.type === 'agent_message' && item.runId === runId)
          .map((item) => item.markdown ?? '')
          .join('\n\n');
      };

      const changed = await ask('change your personality: from now on you are a grumpy old pirate who says "arr" in every reply');
      const listed = await account.api('GET', `/v1/home?path=agents/${agentId}/`);
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      const identity = ((listed.body.files ?? []) as Array<{ path: string; content?: string }>).find((f) => f.path.endsWith('/IDENTITY.md'));
      expect(identity?.content ?? '', changed + ' / ' + JSON.stringify(listed.body)).toMatch(/pirate/i);

      const reply = await ask('what should i eat for lunch');
      expect(reply, reply).toMatch(/\barr+\b/i);
    } finally {
      events.close();
    }
  }, 900_000);
});

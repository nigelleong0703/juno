import { aguiInput } from '../../agui-input.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, insertDocRow, listenEvents, runReport } from '../harness/client';

/**
 * Persona wins on tone with a real model (owner report 2026-10-21): the learned "how this user likes to be answered" is
 * shared by every agent and once said "default warm, friendly"; an agent whose own persona asks for another voice must
 * keep that voice. Checks one marker the persona asks for, never wording otherwise.
 */
describe('real model: persona over learned style', () => {
  it('keeps the persona voice when the learned style asks for a different tone', async () => {
    const account = await createAccount('real-persona-tone');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Tavi' });
      expect(agent.status).toBe(201);
      const agentId: string = agent.body.id;
      const persona = await account.api('PUT', `/v1/home/agents/${agentId}/IDENTITY.md`, {
        content: 'Fearless, blunt and a bit cheeky. You call the user "landlubber" and tease them, but you are on their side.\n',
      });
      expect(persona.status, JSON.stringify(persona.body)).toBe(200);
      // The learned file is written by the nightly job only; seed it as that job would.
      const learned = '# ALIGNMENT_SYNTHESIS.md\n\n## Tone & language\n- Default warm, friendly, polite English; no nicknames, no teasing, no slang\n- If told cold / unfriendly, lengthen and warm up at once\n';
      await insertDocRow('agent_home', account.userId, {
        id: account.userId + ':ALIGNMENT_SYNTHESIS.md', path: 'ALIGNMENT_SYNTHESIS.md', content: learned,
        hash: createHash('sha256').update(learned).digest('hex'), writer: 'platform', ownerId: account.userId, updatedAt: new Date().toISOString(),
      });
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agentId] });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;

      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'any tips for a rainy sunday?' }));
      expect(sent.status).toBe(202);
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId, 240_000);
      expect(finished.data.metadata.juno.run.status, await runReport(account, finished.data.metadata.juno.run.id)).toBe('completed');
      const items = await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`);
      const reply = (items.body.items as Array<{ type: string; runId?: string; markdown?: string }>)
        .filter((item) => item.type === 'agent_message' && item.runId === finished.data.metadata.juno.run.id)
        .map((item) => item.markdown ?? '')
        .join('\n\n');
      expect(reply, reply).toMatch(/landlubber/i);
    } finally {
      events.close();
    }
  }, 600_000);
});

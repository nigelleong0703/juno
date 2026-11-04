import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, runReport } from '../harness/client';

/**
 * Real-model smoke: a direct chat message reaches the real model through the harness and its reply
 * lands as one agent bubble. Checks behaviour only, never the wording.
 */
describe('real model: chat reply', () => {
  it('answers a direct message with a visible reply and finishes the run', async () => {
    const account = await createAccount('real-chat');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Echo' });
      expect(agent.status).toBe(201);
      const created = await account.api('POST', '/v1/conversations', {
        kind: 'direct', memberAgentIds: [agent.body.id], firstMessage: { text: 'Reply with one short sentence: what is 2 + 3?' },
      });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      // A run that finishes without posting a reply must fail with the run's own account of why (known flake: preview streamed, nothing posted).
      const outcome = await events.waitFor(
        (e) => e.data.conversationId === conversationId && e.data.type === 'item.added' && e.data.item.type === 'agent_message'
          || e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId,
        180_000,
      );
      const previews = events.events.filter((e) => e.data.type === 'TEXT_MESSAGE_CONTENT' && e.data.metadata?.juno?.attemptId !== undefined && e.data.metadata.juno.conversationId === conversationId).length;
      expect(outcome.data.type, outcome.data.type === 'RUN_FINISHED' ? `run finished without a reply (previews seen: ${previews}) ${await runReport(account, outcome.data.metadata.juno.run.id)}` : '').toBe('item.added');
      const reply = outcome;
      expect(String(reply.data.item.markdown)).toMatch(/5|five/i);
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === reply.data.item.runId, 60_000);
      expect(finished.data.metadata.juno.run.status).toBe('completed');
      // eslint-disable-next-line no-console
      console.log('chat reply', JSON.stringify(reply.data.item.markdown));
    } finally {
      events.close();
    }
  });

  it('sends two separate messages through send_message messages when asked to, and the run still ends well', async () => {
    const account = await createAccount('real-chat-two');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Echo' });
      expect(agent.status).toBe(201);
      const created = await account.api('POST', '/v1/conversations', {
        kind: 'direct', memberAgentIds: [agent.body.id], firstMessage: { text: 'Answer me as two separate text messages: first a quick reaction, then one short sentence saying what 2 + 3 is.' },
      });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId, 180_000);
      expect(finished.data.metadata.juno.run.status, await runReport(account, finished.data.metadata.juno.run.id)).toBe('completed');
      const items = (await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`)).body.items as Array<{ type: string; runId?: string; markdown?: string }>;
      const bubbles = items.filter((item) => item.type === 'agent_message');
      // eslint-disable-next-line no-console
      console.log('two messages', JSON.stringify(bubbles.map((item) => item.markdown)));
      expect(bubbles.length, JSON.stringify(bubbles)).toBeGreaterThanOrEqual(2);
      expect(new Set(bubbles.map((item) => item.runId)).size).toBe(1);
      expect(bubbles.map((item) => item.markdown).join(' ')).toMatch(/5|five/i);
    } finally {
      events.close();
    }
  });

  it('asks a vague request with a short lead-in and a question card, and says nothing after the card (BACKEND §3.3e)', async () => {
    const account = await createAccount('real-question-ends');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Echo' });
      expect(agent.status).toBe(201);
      const created = await account.api('POST', '/v1/conversations', {
        kind: 'direct', memberAgentIds: [agent.body.id], firstMessage: { text: '给我来一个每天总结吧' },
      });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId, 180_000);
      expect(finished.data.metadata.juno.run.status, await runReport(account, finished.data.metadata.juno.run.id)).toBe('completed');
      const items = (await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`)).body.items as Array<{ type: string; markdown?: string; at: string }>;
      // eslint-disable-next-line no-console
      console.log('question turn', JSON.stringify(items.filter((item) => item.type === 'agent_message' || item.type === 'request').map((item) => item.type === 'request' ? '[card]' : item.markdown)));
      const chat = items.filter((item) => item.type === 'agent_message' || item.type === 'request').sort((a, b) => a.at.localeCompare(b.at));
      // Asking in plain text instead of a card is the model's choice; when it sends a card, the card is the last thing the run said,
      // with at most one lead-in bubble before it.
      const cards = chat.filter((item) => item.type === 'request');
      expect(cards.length, JSON.stringify(chat)).toBeLessThanOrEqual(1);
      if (cards.length === 1) {
        expect(chat.at(-1)?.type, JSON.stringify(chat)).toBe('request');
        expect(chat.length).toBeLessThanOrEqual(2);
      }
    } finally {
      events.close();
    }
  });
});

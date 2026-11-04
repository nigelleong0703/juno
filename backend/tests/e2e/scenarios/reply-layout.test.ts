import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptedChat, toolCall, transcriptMessages, transcriptTexts } from '../harness/client';

const CARD = '```card\n' + JSON.stringify({ version: 1, title: 'Fares', blocks: [{ type: 'facts', rows: [{ label: 'KL', value: 'RM 40' }] }] }) + '\n```';

/** A final reply is ONE bubble, paragraphs and card included; several messages are the model's own choice (send_message messages). */
describe('reply layout', () => {
  it('posts a final reply with paragraphs and a card as one bubble, the card on it', async () => {
    const account = await createAccount('layout');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Layout' });
      const tag = randomUUID().slice(0, 8);
      const { conversationId } = await scriptedChat(account, agent.body.id, [
        { text: `Found it ${tag}.\n\nHere are the fares:\n\n${CARD}` },
      ], 'compare fares');
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 45_000);
      const items = (await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`)).body.items
        .filter((i: { type: string }) => i.type === 'agent_message');
      expect(items.map((i: { markdown: string }) => i.markdown)).toEqual([`Found it ${tag}.\n\nHere are the fares:`]);
      expect(items[0].ui.title).toBe('Fares');
      expect(items[0].runId).toBe(finished.data.metadata.juno.run.id);
    } finally {
      events.close();
    }
  });

  it('posts send_message messages as ordered bubbles of one run, a reading pause apart, and the empty turn after them is not retried', async () => {
    const account = await createAccount('layout-messages');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Messenger' });
      const tag = randomUUID().slice(0, 8);
      const messages = [`KillineyGO is open now ${tag}.\nAbout 10 minutes on foot.`, `Want me to navigate there? ${tag}`];
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-several', 'send_message', { kind: 'text', purpose: 'answer', messages })] },
        { text: '' },
      ], 'that one, killineygo');
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 45_000);
      expect(finished.data.metadata.juno.run.status).toBe('completed');
      const items = (await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`)).body.items
        .filter((i: { type: string }) => i.type === 'agent_message');
      expect(items.map((i: { markdown: string }) => i.markdown)).toEqual(messages);
      expect(new Set(items.map((i: { runId: string }) => i.runId))).toEqual(new Set([finished.data.metadata.juno.run.id]));
      expect(Date.parse(items[1].at) - Date.parse(items[0].at)).toBeGreaterThanOrEqual(400);
      expect((await transcriptTexts(sessionKey)).some((text) => text.includes('Your last turn was empty'))).toBe(false);
    } finally {
      events.close();
    }
  });

  it('sends a reply with an invalid card back to the model once and posts the corrected one', async () => {
    const account = await createAccount('layout-retry');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Retry' });
      const tag = randomUUID().slice(0, 8);
      const bad = `Broken card ${tag}:\n\n\`\`\`card\n{"version":1,"blocks":[]}\n\`\`\``;
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { text: bad },
        { text: `Fixed reply ${tag}.` },
      ], 'compare fares');
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 45_000);
      const posted = (await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`)).body.items
        .filter((i: { type: string }) => i.type === 'agent_message')
        .map((i: { markdown: string }) => i.markdown);
      expect(posted).toEqual([`Fixed reply ${tag}.`]);
      const transcript = await transcriptMessages(sessionKey);
      const hint = transcript.findIndex((m) => m.role === 'user' && m.text.includes('Your last reply was not posted: its card is invalid'));
      const fixed = transcript.findIndex((m) => m.role === 'assistant' && m.text.includes(`Fixed reply ${tag}.`));
      expect(hint).toBeGreaterThan(-1);
      expect(fixed).toBeGreaterThan(hint);
    } finally {
      events.close();
    }
  });

  it('reacts to the user message that woke the run and attaches quick replies to the reply', async () => {
    const account = await createAccount('layout-react');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Reactor' });
      const tag = randomUUID().slice(0, 8);
      const replies = '```card\n' + JSON.stringify({ version: 1, blocks: [{ type: 'replies', options: ['Search more retailers', 'Watch for restock'] }] }) + '\n```';
      const { conversationId } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-react', 'react', { emoji: '👍' })] },
        { text: `Nothing in stock ${tag}.\n\n${replies}` },
      ], 'is the phone in stock');
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 45_000);
      const items = (await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`)).body.items;
      expect(items.find((i: { type: string }) => i.type === 'user_message').reaction).toBe('👍');
      const bubble = items.find((i: { type: string }) => i.type === 'agent_message');
      expect(bubble.markdown).toBe(`Nothing in stock ${tag}.`);
      expect(bubble.ui.blocks).toEqual([{ type: 'replies', options: ['Search more retailers', 'Watch for restock'] }]);
    } finally {
      events.close();
    }
  });
});

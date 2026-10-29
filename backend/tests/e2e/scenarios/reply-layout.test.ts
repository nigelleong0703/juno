import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptedChat, toolCall, transcriptMessages } from '../harness/client';

const CARD = '```card\n' + JSON.stringify({ version: 1, title: 'Fares', blocks: [{ type: 'facts', rows: [{ label: 'KL', value: 'RM 40' }] }] }) + '\n```';

/** A final reply is laid out as bubbles: paragraphs become separate messages and a card rides on its lead-in. */
describe('reply layout', () => {
  it('posts paragraphs as ordered bubbles of one run, with the card on its lead-in', async () => {
    const account = await createAccount('layout');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Layout' });
      const tag = randomUUID().slice(0, 8);
      const { conversationId } = await scriptedChat(account, agent.body.id, [
        { text: `Found it ${tag}.\n\nHere are the fares ${tag}:\n\n${CARD}` },
      ], 'compare fares');
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 45_000);
      const items = (await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`)).body.items
        .filter((i: { type: string }) => i.type === 'agent_message');
      expect(items.map((i: { markdown: string }) => i.markdown)).toEqual([`Found it ${tag}.`, `Here are the fares ${tag}:`]);
      expect(items[0].ui).toBeUndefined();
      expect(items[1].ui.title).toBe('Fares');
      expect(new Set(items.map((i: { runId: string }) => i.runId))).toEqual(new Set([finished.data.metadata.juno.run.id]));
      expect(Date.parse(items[0].at)).toBeLessThan(Date.parse(items[1].at));
    } finally {
      events.close();
    }
  });

  it('posts the first paragraph while the model is still writing the rest (block streaming)', async () => {
    const account = await createAccount('layout-stream');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Streamer' });
      const tag = randomUUID().slice(0, 8);
      // The scripted model streams ~16 characters per 8 ms, so this long second paragraph takes seconds to write.
      const long = `Second ${tag}. ` + 'word '.repeat(1600);
      const sentAt = Date.now();
      const { conversationId } = await scriptedChat(account, agent.body.id, [{ text: `First ${tag}.\n\n${long.trim()}` }], 'tell me');
      const isBubble = (e: { data: { type: string; conversationId?: string; item?: { type: string } } }) => e.data.type === 'item.added' && e.data.conversationId === conversationId && e.data.item?.type === 'agent_message';
      await events.waitFor(isBubble, 45_000);
      const firstBubbleAfterMs = Date.now() - sentAt;
      expect(events.events.some((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId)).toBe(false);
      // Written after the model finished, the first bubble could not arrive before the whole second paragraph was streamed.
      expect(firstBubbleAfterMs).toBeLessThan(3_000);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 60_000);
      const items = (await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`)).body.items
        .filter((i: { type: string }) => i.type === 'agent_message');
      expect(items.map((i: { markdown: string }) => i.markdown)).toEqual([`First ${tag}.`, long.trim()]);
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

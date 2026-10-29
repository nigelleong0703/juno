import { aguiInput } from '../../agui-input.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, modelCalls, scriptModel, toolCall, transcriptMessages, typingPing, type Account } from '../harness/client';

/**
 * Private chats behave like texting a person: the agent starts a second after your last message, holds
 * back while you are typing, and its reply arrives whole. Scripted model; timings are generous (the
 * windows are 1 s to start, 4 s of silence = stopped typing).
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tag = () => randomUUID().slice(0, 8);

async function openChat(account: Account, name: string): Promise<{ conversationId: string; sessionKey: string }> {
  const agent = await account.api('POST', '/v1/agents', { name });
  expect(agent.status).toBe(201);
  const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
  expect(created.status).toBe(201);
  return { conversationId: created.body.id, sessionKey: `${agent.body.id}:${created.body.id}` };
}

const send = async (account: Account, conversationId: string, text: string) => {
  const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }));
  expect(sent.status).toBe(202);
};

describe('private chat like texting', () => {
  it('answers a quick burst of messages with one run and one model call', async () => {
    const account = await createAccount('burst');
    const events = await listenEvents(account.cookie);
    try {
      const { conversationId, sessionKey } = await openChat(account, 'Burst');
      const reply = `BURST-${tag()}`;
      scriptModel(sessionKey, [{ text: reply }]);
      const first = `first ${tag()}`;
      const second = `second ${tag()}`;
      await send(account, conversationId, first);
      await sleep(300);
      await send(account, conversationId, second);

      const answered = await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(reply), 30_000);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === answered.data.item.runId, 30_000);
      expect(events.events.filter((e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === conversationId)).toHaveLength(1);
      expect(modelCalls(sessionKey)).toBe(1);
      const transcript = await transcriptMessages(sessionKey);
      const replyAt = transcript.findIndex((m) => m.role === 'assistant' && m.text.includes(reply));
      expect(transcript.findIndex((m) => m.text.includes(first))).toBeGreaterThan(-1);
      expect(transcript.findIndex((m) => m.text.includes(first))).toBeLessThan(replyAt);
      expect(transcript.findIndex((m) => m.text.includes(second))).toBeLessThan(replyAt);
      expect(transcript.findIndex((m) => m.text.includes(second))).toBeGreaterThan(-1);
    } finally {
      events.close();
    }
  });

  it('holds a ready reply while the user keeps typing, then posts it once they stop', async () => {
    const account = await createAccount('hold');
    const events = await listenEvents(account.cookie);
    try {
      const { conversationId, sessionKey } = await openChat(account, 'Hold');
      const reply = `HELD-${tag()}`;
      // The wake_at keeps the run busy for 4 s, so the reply is ready while the pings are still coming.
      scriptModel(sessionKey, [{ toolCalls: [toolCall('call-wait', 'wake_at', { when: '+4s' })] }, { text: reply }]);
      await send(account, conversationId, 'work on this for a moment');
      await events.waitFor((e) => e.data.type === 'STEP_FINISHED' && e.data.metadata.juno.step?.target === 'wake_at', 30_000);
      const replied = () => events.events.some((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(reply));

      for (let i = 0; i < 8; i += 1) {
        expect((await typingPing(account, conversationId, true)).status).toBe(204);
        await sleep(800);
      }
      // ~6 s of typing, the reply has been ready since ~4 s: nothing was posted.
      expect(replied()).toBe(false);
      const lastPing = Date.now();

      const answered = await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(reply), 15_000);
      expect(answered.data.item.type).toBe('agent_message');
      // Posted only after the pings stopped, within the 4 s presence window plus the 1 s polling.
      expect(Date.now() - lastPing).toBeGreaterThan(1_000);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === answered.data.item.runId, 15_000);
      expect(events.events.filter((e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === conversationId)).toHaveLength(1);
    } finally {
      events.close();
    }
  });

  it('answers a message sent during the hold instead of the held reply, once', async () => {
    const account = await createAccount('hold2');
    const events = await listenEvents(account.cookie);
    try {
      const { conversationId, sessionKey } = await openChat(account, 'Hold2');
      const firstReply = `FIRST-${tag()}`;
      const secondReply = `SECOND-${tag()}`;
      const firstText = `alpha-${tag()}`;
      const secondText = `beta-${tag()}`;
      scriptModel(sessionKey, [
        { toolCalls: [toolCall('call-wait', 'wake_at', { when: '+4s' })] },
        { text: firstReply, matchLastText: firstText },
        { text: secondReply, matchLastText: secondText },
      ]);
      await send(account, conversationId, firstText);
      await events.waitFor((e) => e.data.type === 'STEP_FINISHED' && e.data.metadata.juno.step?.target === 'wake_at', 30_000);
      // Typing through the end of the wait, so the first reply is ready (and held) by ~4 s.
      for (let i = 0; i < 7; i += 1) {
        await typingPing(account, conversationId, true);
        await sleep(800);
      }
      await typingPing(account, conversationId, false);
      await send(account, conversationId, secondText);

      const answered = await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(secondReply), 30_000);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === answered.data.item.runId, 30_000);
      const agentItems = events.events.filter((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && e.data.item.type === 'agent_message');
      expect(agentItems.map((e) => e.data.item.markdown)).toEqual([secondReply]);
      expect(events.events.filter((e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === conversationId)).toHaveLength(1);
      // The held reply was written (turn 2) and dropped; the new message got its own model call (turn 3).
      expect(modelCalls(sessionKey)).toBe(3);
    } finally {
      events.close();
    }
  });
});

import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, insertDocRow, listItems, listRuns, listenEvents, request, scriptModel, toolCall, waitForTranscript } from '../harness/client';

/**
 * A private question in a group (BACKEND 8.0b): the owner asks in a platform group, the agent calls send_message toOwner, which posts the
 * note in the owner's direct chat and wakes the agent there with the original question and the source chat. That run serves the owner
 * alone, and its final reply is the answer; the group hears only the short "I'll answer privately".
 */
const SECRET = 'e2e-channel-secret';
const OWNER_EXT = 'owner-ext';
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('a private question in a group', () => {
  it('is handed to the owner\'s direct chat: the run there sees the question and the source chat, its final reply is the answer, the group gets only the short reply', async () => {
    const account = await createAccount('handoff', 'Robin');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Nova' });
      expect(agent.status).toBe(201);
      const agentId: string = agent.body.id;
      // Creating the agent opened its direct chat and woke it to greet; let that finish so the hand-off is the only wake there.
      let direct = '';
      for (let i = 0; i < 60 && direct === ''; i += 1) {
        const chats = (await account.api('GET', '/v1/conversations')).body.items as Array<{ id: string; kind: string; agentIds: string[] }>;
        direct = chats.find((chat) => chat.kind === 'direct' && chat.agentIds.includes(agentId))?.id ?? '';
        if (direct === '') await new Promise((r) => setTimeout(r, 250));
      }
      expect(direct).not.toBe('');
      for (let i = 0; i < 60 && ((await listRuns(account, direct)).length === 0 || !(await listRuns(account, direct)).every((run) => run.status === 'completed')); i += 1) await new Promise((r) => setTimeout(r, 500));

      const channelId = 'bot-' + randomUUID().slice(0, 8);
      const now = new Date().toISOString();
      await insertDocRow('channels', account.userId, {
        id: `telegram:${channelId}`, agentId, kind: 'telegram', channelId, secretHashHex: sha(SECRET),
        ownerExternalId: OWNER_EXT, status: 'active', createdAt: now, updatedAt: now,
      }, { agentId, kind: 'telegram' });
      const threadId = 'group-1';
      const group = 'cvn-' + sha([account.userId, 'telegram', channelId, threadId].join('\n')).slice(0, 24);
      const question = 'Nova, what time is my flight tomorrow?';
      const [note, answer, groupReply] = ['Looking up your flight', 'Your flight leaves at 07:45.', 'I will answer you privately.'];
      scriptModel(`${agentId}:${group}`, [
        { matchLastText: 'my flight', step: 0, toolCalls: [toolCall('call-handoff', 'send_message', { kind: 'text', text: note, toOwner: true })] },
        { matchLastText: 'my flight', step: 1, text: groupReply },
      ]);
      scriptModel(`${agentId}:${direct}`, [{ matchLastText: 'my flight', step: 0, text: answer }]);

      const said = await request('POST', `/v1/channels/telegram/${channelId}/events`, {
        chatType: 'group', threadId, chatId: 'chat-1', chatTitle: 'Friends', text: question, externalMessageId: randomUUID(), from: { id: OWNER_EXT, name: 'Robin' },
      }, undefined, { 'x-telegram-bot-api-secret-token': SECRET });
      expect(said.status).toBe(202);

      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === direct && String(e.data.item.markdown).includes(answer), 60_000);
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === group && String(e.data.item.markdown).includes(groupReply), 60_000);

      // The direct chat: the note, then the answer, once each.
      const privateTexts = (await listItems(account, direct)).filter((item) => item.type === 'agent_message').map((item) => item.markdown ?? '');
      expect(privateTexts.slice(-2)).toEqual([note, answer]);
      expect(privateTexts.filter((text) => text === answer)).toHaveLength(1);
      // The group hears only the short reply.
      const groupTexts = (await listItems(account, group)).filter((item) => item.type === 'agent_message').map((item) => item.markdown ?? '');
      expect(groupTexts).toEqual([groupReply]);
      // The run in the direct chat was woken with the question and where it came from.
      const woken = (await waitForTranscript(`${agentId}:${direct}`, (messages) => messages.some((text) => text.includes('Their message there:')))).find((text) => text.includes('Their message there:')) ?? '';
      expect(woken).toContain(`Their message there: ${question}`);
      expect(woken).toContain('Friends · Telegram');
      expect(woken).toContain(`Your note: ${note}`);
    } finally {
      events.close();
    }
  }, 180_000);
});

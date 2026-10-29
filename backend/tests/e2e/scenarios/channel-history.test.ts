import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, insertDocRow, listenEvents, request, scriptedChat, scriptModel, toolCall, waitForToolActivity } from '../harness/client';

/**
 * The chat tools through the whole stack. There is no fake Discord / Slack server in the e2e stack (their API hosts are fixed), so
 * what runs here is the wiring: the hidden `channel_history` tool is found through `tool_call`, a stranger-woken run may use it without
 * an approval card, a platform without history (Telegram) answers "not available here" instead of an error, a chat that is not a
 * platform chat says so, and `react` in a platform chat goes through the platform port (this channel has no credentials, so the port
 * answers "not available here"). The platform calls themselves are covered by the unit tests with fake transports.
 */
const SECRET = 'e2e-channel-secret';
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('channel_history and react in chats', () => {
  it('a stranger in a Telegram group: history and reactions are "not available here", with no approval asked', async () => {
    const account = await createAccount('chan-history');
    const agent = await account.api('POST', '/v1/agents', { name: 'Nova' });
    expect(agent.status).toBe(201);
    const channelId = 'bot-' + randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    await insertDocRow('channels', account.userId, {
      id: `telegram:${channelId}`, agentId: agent.body.id, kind: 'telegram', channelId, secretHashHex: sha(SECRET),
      ownerExternalId: 'owner-ext', status: 'active', createdAt: now, updatedAt: now,
    }, { agentId: agent.body.id, kind: 'telegram' });
    const threadId = 'group-1';
    const conversationId = 'cvn-' + sha([account.userId, 'telegram', channelId, threadId].join('\n')).slice(0, 24);
    const sessionKey = `${agent.body.id}:${conversationId}`;
    const events = await listenEvents(account.cookie);
    try {
      const done = `HISTORY-${randomUUID().slice(0, 8)}`;
      scriptModel(sessionKey, [
        { matchLastText: 'what-was-said', step: 0, toolCalls: [toolCall('call-history', 'channel_history', {})] },
        { matchLastText: 'what-was-said', step: 1, toolCalls: [toolCall('call-react', 'react', { emoji: '👀' })] },
        { matchLastText: 'what-was-said', step: 2, text: done },
      ]);
      const sent = await request('POST', `/v1/channels/telegram/${channelId}/events`, {
        chatType: 'group', threadId, chatId: 'chat-1', chatTitle: 'Friends', text: 'what-was-said', externalMessageId: 'chat-1:77', from: { id: 'stranger-9', name: 'Bob' },
      }, undefined, { 'x-telegram-bot-api-secret-token': SECRET });
      expect(sent.status).toBe(202);
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(done), 30_000);
      const activity = await waitForToolActivity(sessionKey, (a) => a.results.some((r) => r.toolName === 'react'));
      const history = activity.results.find((r) => r.toolName === 'channel_history');
      expect(history).toMatchObject({ isError: false, text: 'Reading earlier messages is not available here.' });
      expect(activity.results.find((r) => r.toolName === 'react')).toMatchObject({ isError: false, text: 'Reactions are not available here.' });
      // Both are in the stranger allowlist: nothing was asked of the owner.
      expect(events.events.filter((e) => e.data.type === 'request.created' && e.data.request.conversationId === conversationId)).toHaveLength(0);
    } finally {
      events.close();
    }
  });

  it('in the Juno app there is no platform chat to read', async () => {
    const account = await createAccount('chan-history-app');
    const agent = await account.api('POST', '/v1/agents', { name: 'Nova' });
    const done = `APP-${randomUUID().slice(0, 8)}`;
    const { sessionKey } = await scriptedChat(account, agent.body.id, [
      { toolCalls: [toolCall('call-history', 'channel_history', {})] },
      { text: done },
    ], 'read the chat history');
    const activity = await waitForToolActivity(sessionKey, (a) => a.results.some((r) => r.toolName === 'channel_history'));
    const result = activity.results.find((r) => r.toolName === 'channel_history');
    expect(result?.isError).toBe(false);
    expect(result?.text).toContain('not a platform chat');
  });
});

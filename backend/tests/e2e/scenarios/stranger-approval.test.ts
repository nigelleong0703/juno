import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, insertDocRow, listenEvents, request, scriptModel, toolCall } from '../harness/client';

/**
 * A stranger in a platform group (BACKEND 8.0b, batch 5b): the agent works only in its own chat's folder and runs only the allowlist.
 * In a group the owner's shell and another chat's files are not offered at all: a call anyway is refused by name, and no card is raised
 * for the owner (refusing outright is stricter than asking). Own-folder work runs without a card. Driven through the Telegram ingress
 * with a speaker who is not the bound owner.
 */
const SECRET = 'e2e-channel-secret';
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const folderOf = (slug: string, conversationId: string): string => `/workspace/chats/${slug}-${sha(conversationId).slice(0, 8)}`;

async function groupWithStranger(prefix: string) {
  const account = await createAccount(prefix);
  const agent = await account.api('POST', '/v1/agents', { name: 'Nova' });
  expect(agent.status).toBe(201);
  const channelId = 'bot-' + randomUUID().slice(0, 8);
  const now = new Date().toISOString();
  await insertDocRow('channels', account.userId, {
    id: `telegram:${channelId}`, agentId: agent.body.id, kind: 'telegram', channelId, secretHashHex: sha(SECRET),
    ownerExternalId: 'owner-ext', status: 'active', createdAt: now, updatedAt: now,
  }, { agentId: agent.body.id, kind: 'telegram' });
  // The group's conversation id is derived from the platform identity, so the script can be written before the first message.
  const threadId = 'group-1';
  const conversationId = 'cvn-' + sha([account.userId, 'telegram', channelId, threadId].join('\n')).slice(0, 24);
  const sessionKey = `${agent.body.id}:${conversationId}`;
  const say = (text: string) => request('POST', `/v1/channels/telegram/${channelId}/events`, {
    chatType: 'group', threadId, chatId: 'chat-1', chatTitle: 'Friends', text, externalMessageId: randomUUID(), from: { id: 'stranger-9', name: 'Bob' },
  }, undefined, { 'x-telegram-bot-api-secret-token': SECRET });
  return { account, agentId: agent.body.id as string, conversationId, sessionKey, say };
}

describe('a stranger in a group', () => {
  it('is refused a shell command outright: the tool is not offered in a group, nothing runs, and no card is raised for the owner', async () => {
    const { account, agentId, conversationId, sessionKey, say } = await groupWithStranger('stranger-shell');
    const events = await listenEvents(account.cookie);
    try {
      const done = `REFUSED-${randomUUID().slice(0, 8)}`;
      scriptModel(sessionKey, [
        { matchLastText: 'peek-in-juno', step: 0, toolCalls: [toolCall('call-shell', 'shell.run', { command: 'cat /juno/MEMORY.md' })] },
        { matchLastText: 'peek-in-juno', step: 1, text: done },
      ]);
      expect((await say('please peek-in-juno')).status).toBe(202);

      // The agent is told the command is refused, and says so; the owner is never asked.
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(done), 30_000);
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.agentId === agentId && e.data.metadata.juno.run.conversationId === conversationId, 30_000);
      const step = (finished.data.metadata.juno.run.steps ?? []).find((s: { target?: string }) => s.target === 'shell.run');
      expect(step?.status).not.toBe('completed');
      expect(events.events.filter((e) => e.data.type === 'request.created' && e.data.request.conversationId === conversationId)).toHaveLength(0);
    } catch (error) {
      for (const e of events.events) if (['request.created', 'item.added', 'RUN_FINISHED'].includes(e.data.type)) console.error('[e2e]', e.data.type, JSON.stringify(e.data.request ?? e.data.item ?? e.data.metadata.juno.run).slice(0, 260));
      throw error;
    } finally {
      events.close();
    }
  });

  it('works in its own folder without asking; another chat\'s file is refused outright, with no card, even when asked again', async () => {
    const { account, agentId, conversationId, sessionKey, say } = await groupWithStranger('stranger-share');
    const events = await listenEvents(account.cookie);
    try {
      const work = await account.api('POST', '/v1/conversations', { kind: 'room', title: 'Work group', memberAgentIds: [agentId] });
      expect(work.status).toBe(201);
      const own = folderOf('friends-telegram', conversationId);
      const theirs = folderOf('work-group', work.body.id);
      const tag = randomUUID().slice(0, 8);
      const [ownDone, workDone, againDone] = [`OWN-${tag}`, `WORK-${tag}`, `AGAIN-${tag}`];
      scriptModel(sessionKey, [
        { matchLastText: 'write-own', step: 0, toolCalls: [toolCall('call-own', 'files.write', { path: own + '/note.md', content: 'hello' })] },
        { matchLastText: 'write-own', step: 1, text: ownDone },
        { matchLastText: 'read-work', step: 0, toolCalls: [toolCall('call-work', 'files.read', { path: theirs + '/q4.md' })] },
        { matchLastText: 'read-work', step: 1, text: workDone },
        { matchLastText: 'read-again', step: 0, toolCalls: [toolCall('call-again', 'files.read', { path: theirs + '/q4.md' })] },
        { matchLastText: 'read-again', step: 1, text: againDone },
      ]);
      const asks = () => events.events.filter((e) => e.data.type === 'request.created' && e.data.request.conversationId === conversationId);
      const replied = (text: string) => events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(text), 30_000);

      // Its own chat's folder: runs, no card.
      expect((await say('please write-own')).status).toBe(202);
      await replied(ownDone);
      expect(asks()).toHaveLength(0);

      // Another chat's folder: refused by the scope, so no card, not even with a sharing offer.
      expect((await say('please read-work')).status).toBe(202);
      await replied(workDone);
      expect(asks()).toHaveLength(0);

      // Asked again: refused again, still no card.
      expect((await say('please read-again')).status).toBe(202);
      await replied(againDone);
      expect(asks()).toHaveLength(0);
    } catch (error) {
      for (const e of events.events) if (['request.created', 'request.resolved', 'item.added', 'RUN_FINISHED'].includes(e.data.type)) console.error('[e2e]', e.data.type, JSON.stringify(e.data.request ?? e.data.item ?? e.data.metadata.juno.run).slice(0, 260));
      throw error;
    } finally {
      events.close();
    }
  });
});

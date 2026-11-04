import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { advanceClock, createAccount, insertDocRow, listRuns, request, restartAgentd, scriptedChat, scriptModel, stackUrls, transcriptTexts, type Account } from '../harness/client';
import { FakeFcm } from '../harness/fcm';
import { FakeSlack, SLACK_PEOPLE } from '../harness/slack';

/**
 * The outbox through the whole stack (BACKEND 5.7.11): every delivery to a platform chat or a phone is a durable row that is retried, kept in order,
 * visible to the owner, and stopped by a freeze. Slack's and FCM's stand-ins listen on the stack's fixed ports (agentd talks to them exactly like to
 * the real services) and can be told to fail; the file is exclusive because those ports are single and one case kills agentd.
 *  (a) a platform failing twice with 503 then working: one delivery, and the message behind it waits, then goes, in order
 *  (b) agentd restarted between a reply being stored and its send: delivered after the restart, once
 *  (c) the chat is gone: dropped at once, listed, shown on the bubble, and the agent hears about it exactly once
 *  (d) a freeze sends nothing and shows why; unfreezing sends in order
 *  (e) a push that fails transiently is retried
 */
const SECRET = 'e2e-channel-secret';
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const OWNER_SLACK = SLACK_PEOPLE['owner']?.id ?? 'U0ROBIN';

const fake = new FakeSlack();
const fcm = new FakeFcm();
beforeAll(async () => {
  await fake.listen(Number(new URL(stackUrls().slackUrl).port));
  await fcm.listen(Number(new URL(stackUrls().fcmUrl).port));
});
afterAll(async () => {
  await fake.close();
  await fcm.close();
});

const until = async <T>(what: string, read: () => Promise<T | undefined> | T | undefined, seconds = 40): Promise<T> => {
  for (let i = 0; i < seconds * 4; i += 1) {
    const found = await read();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`never happened: ${what}`);
};
const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

interface Entry { id: string; status: string; reason?: string; attempts: number; sourceId: string; lastError?: string }
interface OutboxBody { items: Entry[]; frozen: { owner: boolean; operator: boolean } }

/** A Slack workspace app connected to a fresh account's agent, and the owner's DM with it. */
async function slackDm(prefix: string): Promise<{ account: Account; agentId: string; channelId: string; chat: string; conversationId: string; sessionKey: string; origin: Record<string, unknown>; event: (text: string) => ReturnType<typeof request> }> {
  const account = await createAccount(prefix);
  const agent = await account.api('POST', '/v1/agents', { name: 'Nova' });
  expect(agent.status).toBe(201);
  const agentId: string = agent.body.id;
  const channelId = 'ws-' + randomUUID().slice(0, 8);
  const chat = 'D0' + randomUUID().slice(0, 8).toUpperCase();
  const now = new Date().toISOString();
  await insertDocRow('channels', account.userId, {
    id: `slack:${channelId}`, agentId, kind: 'slack', channelId, secretHashHex: sha(SECRET), ownerExternalId: OWNER_SLACK,
    botToken: 'xoxb-e2e-not-a-secret', botUserId: 'UBOTNOVA', teamId: 'T0TEAM', displayName: 'Nova', status: 'active', createdAt: now, updatedAt: now,
  }, { agentId, kind: 'slack' });
  const conversationId = 'cvn-' + sha([account.userId, 'slack', channelId, chat].join('\n')).slice(0, 24);
  const event = (text: string) => request('POST', `/v1/channels/slack/${channelId}/events`, {
    type: 'event_callback', event_id: 'Ev' + randomUUID(), team_id: 'T0TEAM',
    event: { type: 'message', channel_type: 'im', channel: chat, user: OWNER_SLACK, text, ts: String(Date.now() / 1000) },
  }, undefined, { 'x-channel-secret': SECRET });
  return { account, agentId, channelId, chat, conversationId, sessionKey: `${agentId}:${conversationId}`, origin: { kind: 'slack', channelId, chatId: chat, threadId: chat, chatType: 'private' }, event };
}

/** An agent reply stored directly (as a run would store it), for the cases that are about delivery and not about the model. */
async function storeReply(room: Awaited<ReturnType<typeof slackDm>>, text: string, afterMs = 0): Promise<string> {
  // The DM exists once a platform message has made it; the cases that store replies directly make it the same way (the platform chat it is pinned to).
  if ((await room.account.api('GET', `/v1/conversations/${room.conversationId}`)).status === 404) {
    const now = new Date().toISOString();
    await insertDocRow('conversations', room.account.userId, {
      id: room.conversationId, kind: 'direct', title: 'Slack · Nova', agentIds: [room.agentId], memberIds: [room.account.userId], unreadCount: 0, lastItemAt: now, createdAt: now,
      channel: { kind: 'slack', channelId: room.channelId, threadId: room.chat, chatId: room.chat },
    }, {});
  }
  const id = 'itm-' + randomUUID().slice(0, 12);
  await insertDocRow('items', room.account.userId, {
    id, conversationId: room.conversationId, type: 'agent_message', agentId: room.agentId, markdown: text, citations: [], runId: 'run-' + id, replyTo: room.origin,
    at: new Date(Date.now() + afterMs).toISOString(),
  }, { conversationId: room.conversationId });
  return id;
}

const outbox = async (account: Account, query = ''): Promise<OutboxBody> => (await account.api('GET', '/v1/outbox' + query)).body as OutboxBody;
const textsTo = (chat: string): string[] => fake.attempts.filter((attempt) => attempt.channel === chat).map((attempt) => attempt.text);

describe('the outbox', () => {
  it('(a) retries a 503 twice then delivers once, and the message behind it waits, then goes in order', async () => {
    const room = await slackDm('outbox-a');
    scriptModel(room.sessionKey, [{ matchLastText: 'hello-a', step: 0, text: 'Reply A' }]);
    fake.failures.push({ status: 503 }, { status: 503 });
    expect((await room.event('hello-a')).status).toBeLessThan(300);
    await until('the first try', () => (textsTo(room.chat).length >= 1 ? true : undefined));
    // A second reply, stored after the first: it must not overtake the one that is still retrying.
    await storeReply(room, 'Reply B', 2_000);
    const waiting = await until('both queued', async () => { const body = await outbox(room.account, '?status=pending'); return body.items.length === 2 ? body : undefined; });
    expect(waiting.items.find((entry) => entry.attempts >= 1)?.lastError).toContain('503');
    expect(textsTo(room.chat)).toEqual(['Reply A']);

    await advanceClock(6_000);
    await until('the second try', () => (textsTo(room.chat).length >= 2 ? true : undefined));
    expect(textsTo(room.chat)).toEqual(['Reply A', 'Reply A']);
    await advanceClock(11_000);
    await until('both delivered', () => (textsTo(room.chat).length >= 4 ? true : undefined));
    expect(textsTo(room.chat)).toEqual(['Reply A', 'Reply A', 'Reply A', 'Reply B']);
    expect(fake.attempts.filter((attempt) => attempt.channel === room.chat).map((attempt) => attempt.status)).toEqual([503, 503, 200, 200]);
    expect((await outbox(room.account, '?status=pending')).items).toEqual([]);
    const items = (await room.account.api('GET', `/v1/conversations/${room.conversationId}/items`)).body.items as Array<{ type: string; markdown?: string; delivery?: { status: string } }>;
    expect(items.filter((item) => item.type === 'agent_message').map((item) => [item.markdown, item.delivery?.status])).toEqual([['Reply A', 'sent'], ['Reply B', 'sent']]);
  });

  it('(b) a restart between the reply being stored and its send loses nothing and sends it once', async () => {
    const room = await slackDm('outbox-b');
    const text = 'Stored before the restart ' + randomUUID().slice(0, 6);
    await storeReply(room, text);
    await restartAgentd();
    await until('delivered after the restart', () => (textsTo(room.chat).includes(text) ? true : undefined), 60);
    // Wait out several scans: a boot catch-up that forgot what was sent would send it again.
    await pause(8_000);
    expect(textsTo(room.chat)).toEqual([text]);
  });

  it('(c) a chat that is gone drops the delivery at once, lists it, marks the bubble, and tells the agent once', async () => {
    const room = await slackDm('outbox-c');
    scriptModel(room.sessionKey, [{ matchLastText: 'hello-c', step: 0, text: 'Reply C' }]);
    fake.failures.push({ status: 200, body: { ok: false, error: 'channel_not_found' } });
    expect((await room.event('hello-c')).status).toBeLessThan(300);
    const dropped = await until('the dropped delivery', async () => { const body = await outbox(room.account, '?status=dropped&conversationId=' + room.conversationId); return body.items.length === 1 ? body : undefined; });
    expect(dropped.items[0]).toMatchObject({ status: 'dropped', reason: 'channel_gone', attempts: 1 });
    // The agent got one system note in that conversation and ran once on it; nothing was sent again.
    await until('the delivery-failed note', async () => ((await transcriptTexts(room.sessionKey)).some((text) => text.includes('[delivery failed]')) ? true : undefined));
    await pause(6_000);
    const notes = (await transcriptTexts(room.sessionKey)).filter((text) => text.includes('[delivery failed]'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('It will not arrive');
    expect((await listRuns(room.account, room.conversationId)).length).toBe(2);
    expect(textsTo(room.chat)).toEqual(['Reply C']);
    const bubble = ((await room.account.api('GET', `/v1/conversations/${room.conversationId}/items`)).body.items as Array<{ type: string; delivery?: unknown }>).find((item) => item.type === 'agent_message');
    expect(bubble?.delivery).toEqual({ status: 'dropped', reason: 'channel_gone' });
    // The owner can put it back; the chat works again now, so it is sent.
    const retried = await room.account.api('POST', `/v1/outbox/${dropped.items[0]?.id ?? ''}/retry`);
    expect(retried.status).toBe(200);
    await until('the retry delivered', () => (textsTo(room.chat).length >= 2 ? true : undefined));
    expect(await room.account.api('POST', `/v1/outbox/${dropped.items[0]?.id ?? ''}/retry`)).toMatchObject({ status: 409 });
  });

  it('(d) a freeze sends nothing and says so; unfreezing sends in order', async () => {
    const room = await slackDm('outbox-d');
    expect((await room.account.api('POST', '/v1/outbox/freeze', { frozen: true })).body).toEqual({ frozen: true });
    await storeReply(room, 'Frozen one');
    await storeReply(room, 'Frozen two', 1_000);
    const held = await until('both held', async () => { const body = await outbox(room.account, '?status=pending'); return body.items.length === 2 ? body : undefined; });
    expect(held.frozen).toEqual({ owner: true, operator: false });
    await pause(6_000);
    expect(textsTo(room.chat)).toEqual([]);
    expect((await outbox(room.account, '?status=pending')).items.map((entry) => entry.attempts)).toEqual([0, 0]);
    expect((await room.account.api('POST', '/v1/outbox/freeze', { frozen: false })).body).toEqual({ frozen: false });
    await until('sent after unfreezing', () => (textsTo(room.chat).length >= 2 ? true : undefined));
    expect(textsTo(room.chat)).toEqual(['Frozen one', 'Frozen two']);
  });

  it('(e) a push that fails transiently is retried and arrives once', async () => {
    const account = await createAccount('outbox-e');
    const agent = await account.api('POST', '/v1/agents', { name: 'Pushy' });
    const token = 'fcm-' + randomUUID().replace(/-/g, '') + 'x'.repeat(64);
    expect((await account.api('POST', '/v1/devices', { platform: 'android', token, bundleId: 'io.github.nigelleong0703.juno' })).status).toBeLessThan(300);
    fcm.failures.push({ status: 503, body: { error: { status: 'UNAVAILABLE' } } });
    await scriptedChat(account, agent.body.id, [{ text: 'All done' }], 'do the thing');
    await until('the first push try', () => (fcm.sends.filter((send) => send.token === token).length >= 1 ? true : undefined));
    expect(fcm.sends.filter((send) => send.token === token)[0]?.status).toBe(503);
    expect((await outbox(account, '?status=pending')).items).toMatchObject([{ attempts: 1, lastError: expect.stringContaining('push service') }]);
    await advanceClock(6_000);
    await until('the retry', () => (fcm.sends.filter((send) => send.token === token).length >= 2 ? true : undefined));
    await pause(4_000);
    const sends = fcm.sends.filter((send) => send.token === token);
    expect(sends.map((send) => send.status)).toEqual([503, 200]);
    expect(sends[1]?.title).toBe('Pushy finished');
    expect((await outbox(account, '?status=pending')).items).toEqual([]);
  });
});

/**
 * What each platform's sender says about a failed send (the outbox retries or gives up by it), and the idempotency keys the platforms that have one are given.
 * Platform facts are from their docs: Telegram sendMessage (core.telegram.org/bots/api, ResponseParameters.retry_after), Slack chat.postMessage error codes
 * (docs.slack.dev/reference/methods/chat.postMessage), Discord Create Message nonce / enforce_nonce (docs.discord.com/developers/resources/message), Feishu
 * send / reply message `uuid` and error codes (open.feishu.cn/document/server-docs/im-v1/message/create).
 */
import { describe, expect, it } from 'vitest';
import type { ChannelRow } from '@agent-desktop/contracts';
import { createDiscordSender } from '../discord/api.js';
import { clearFeishuTokenCache, createFeishuSender } from '../feishu/api.js';
import { createSlackSender } from '../slack/send.js';
import { createTelegramSender } from '../telegram/send.js';

const channel = { id: 'x:1', kind: 'x', channelId: 'chan', botToken: 'tok', agentId: 'a', secretHashHex: 'h', createdAt: 'now', updatedAt: 'now' } as unknown as ChannelRow;
const target = { channel, chatId: 'C1', threadId: 'C1' };
const reply = (status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch => async () => Response.json(body, { status, headers });
const failureOf = async (result: ReturnType<ReturnType<typeof createTelegramSender>['sendText']>) => { const r = await result; return r.ok ? undefined : r.failure; };

describe('Telegram', () => {
  const send = (fetchFn: typeof fetch) => failureOf(createTelegramSender(fetchFn).sendText(target, 'x'));
  it('waits as long as flood control says, treats a gone chat or a kicked bot as permanent, a bad token as the credential', async () => {
    expect(await send(reply(429, { ok: false, description: 'Too Many Requests: retry after 12', parameters: { retry_after: 12 } }))).toEqual({ kind: 'transient', retryAfterMs: 12_000 });
    expect(await send(reply(400, { ok: false, description: 'Bad Request: chat not found' }))).toEqual({ kind: 'channel_gone' });
    expect(await send(reply(403, { ok: false, description: 'Forbidden: bot was kicked from the group chat' }))).toEqual({ kind: 'channel_gone' });
    expect(await send(reply(401, { ok: false, description: 'Unauthorized' }))).toEqual({ kind: 'token_invalid' });
    expect(await send(reply(400, { ok: false, description: 'Bad Request: message is too long' }))).toEqual({ kind: 'content_rejected' });
    expect(await send(reply(502, {}))).toEqual({ kind: 'transient' });
    expect(await send(async () => { throw new Error('socket hang up'); })).toEqual({ kind: 'transient' });
  });
});

describe('Slack', () => {
  const send = (fetchFn: typeof fetch) => failureOf(createSlackSender(fetchFn).sendText(target, 'x'));
  it('reads the error code Slack answers with on a 200', async () => {
    expect(await send(reply(200, { ok: false, error: 'invalid_auth' }))).toEqual({ kind: 'token_invalid' });
    expect(await send(reply(200, { ok: false, error: 'token_revoked' }))).toEqual({ kind: 'token_invalid' });
    expect(await send(reply(200, { ok: false, error: 'is_archived' }))).toEqual({ kind: 'channel_gone' });
    expect(await send(reply(200, { ok: false, error: 'not_in_channel' }))).toEqual({ kind: 'channel_gone' });
    expect(await send(reply(200, { ok: false, error: 'internal_error' }))).toEqual({ kind: 'transient' });
    expect(await send(reply(200, { ok: false, error: 'invalid_blocks' }))).toEqual({ kind: 'content_rejected' });
    expect(await send(reply(429, {}, { 'retry-after': '3' }))).toEqual({ kind: 'transient', retryAfterMs: 3000 });
  });
});

describe('Discord', () => {
  const calls: Array<Record<string, unknown>> = [];
  const record = (status: number, body: unknown): typeof fetch => async (_url, init) => { calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return Response.json(body, { status }); };
  it('gives every message the row\'s nonce and enforces it, a different one per message of a split reply', async () => {
    const long = 'a'.repeat(2500);
    await createDiscordSender(record(200, { id: 'm1' })).sendText({ ...target, idempotencyKey: 'obx:reply:itm-1' }, long);
    expect(calls).toHaveLength(2);
    expect(calls.map((body) => body['enforce_nonce'])).toEqual([true, true]);
    const nonces = calls.map((body) => String(body['nonce']));
    expect(new Set(nonces).size).toBe(2);
    expect(nonces.every((nonce) => nonce.length <= 25)).toBe(true);
    calls.length = 0;
    await createDiscordSender(record(200, { id: 'm1' })).sendText(target, 'no key');
    expect(calls[0]).not.toHaveProperty('nonce');
  });
  it('reads 403 and 404 as the chat, 401 as the token, 429 with its retry_after, 5xx as transient', async () => {
    const send = (status: number, body: unknown) => failureOf(createDiscordSender(reply(status, body)).sendText(target, 'x'));
    expect(await send(403, { message: 'Missing Access' })).toEqual({ kind: 'channel_gone' });
    expect(await send(404, { message: 'Unknown Channel' })).toEqual({ kind: 'channel_gone' });
    expect(await send(401, { message: '401: Unauthorized' })).toEqual({ kind: 'token_invalid' });
    expect(await send(429, { message: 'You are being rate limited.', retry_after: 1.5 })).toEqual({ kind: 'transient', retryAfterMs: 1500 });
    expect(await send(500, {})).toEqual({ kind: 'transient' });
    expect(await send(400, { message: 'Cannot send an empty message' })).toEqual({ kind: 'content_rejected' });
  });
});

describe('Feishu', () => {
  const feishu = { ...channel, domain: 'feishu' } as ChannelRow;
  /** Answers the token call, then the send with `answer`; records the send bodies. */
  function platform(answer: { status: number; body: unknown }) {
    const sends: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
      sends.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json(answer.body, { status: answer.status });
    };
    return { fetchFn, sends };
  }
  it('sends a uuid (at most 50 characters) on create and on reply, the same one for the same row', async () => {
    clearFeishuTokenCache();
    const ok = platform({ status: 200, body: { code: 0, data: { message_id: 'om_1' } } });
    const sender = createFeishuSender(ok.fetchFn);
    await sender.sendText({ channel: feishu, chatId: 'oc_1', threadId: 'oc_1', idempotencyKey: 'obx:reply:itm-1' }, 'hi');
    await sender.sendText({ channel: feishu, chatId: 'oc_1', threadId: 'oc_1:om_root', idempotencyKey: 'obx:reply:itm-1' }, 'hi');
    expect(ok.sends[0]?.url).toContain('/im/v1/messages?receive_id_type=chat_id');
    expect(ok.sends[1]?.url).toContain('/im/v1/messages/om_root/reply');
    const uuids = ok.sends.map((send) => String(send.body['uuid']));
    expect(uuids[0]).toBe(uuids[1]);
    expect(uuids[0]?.length).toBeLessThanOrEqual(50);
  });
  it('reads the error codes: bot not in chat and disbanded chat are permanent, the frequency limit is transient', async () => {
    const send = async (code: number) => { clearFeishuTokenCache(); return failureOf(createFeishuSender(platform({ status: 400, body: { code, msg: 'x' } }).fetchFn).sendText({ channel: feishu, chatId: 'oc_1', threadId: 'oc_1' }, 'x')); };
    expect(await send(230002)).toEqual({ kind: 'channel_gone' });
    expect(await send(232009)).toEqual({ kind: 'channel_gone' });
    expect(await send(230020)).toEqual({ kind: 'transient' });
    expect(await send(230001)).toEqual({ kind: 'content_rejected' });
  });
});

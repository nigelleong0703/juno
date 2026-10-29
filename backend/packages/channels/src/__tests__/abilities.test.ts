/**
 * The capability layer of every platform (react / unreact / history / attachment / sendFile) against a fake transport: the URL, method,
 * credentials and body each call makes, and what comes back. No live network.
 */
import { describe, expect, it } from 'vitest';
import { reactionAllowed } from '@agent-desktop/public-contracts';
import { discordAdapter, feishuAdapter, slackAdapter, telegramAdapter, type ChannelAdapter } from '../sdk.js';
import { FEISHU_SCOPE_GROUP_MESSAGES, FEISHU_SCOPE_REACTIONS } from '../feishu/abilities.js';
import { discordAbilities } from '../discord/abilities.js';
import { feishuAbilities } from '../feishu/abilities.js';
import { slackAbilities } from '../slack/abilities.js';
import { telegramAbilities } from '../telegram/abilities.js';

const CHANNEL_PLATFORMS: Record<string, ChannelAdapter> = { telegram: telegramAdapter, slack: slackAdapter, feishu: feishuAdapter, discord: discordAdapter };

interface Call { url: string; method: string; auth: string | null; body: Record<string, unknown> }

/** A fetch that records each call and answers with `reply(call)` (JSON body, optional status). */
function fakeFetch(reply: (call: Call) => { body?: unknown; status?: number }) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const call: Call = { url: String(input), method: init?.method ?? 'GET', auth: headers.get('authorization'), body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {} };
    calls.push(call);
    const { body, status = 200 } = reply(call);
    return status === 204 ? new Response(null, { status }) : Response.json(body ?? {}, { status });
  };
  return { fetchFn, calls };
}

const MSG = { chatId: 'C1', messageId: '1700000000.000100' };

describe('Discord', () => {
  const auth = { token: 'bot-token' };

  it('reacts and unreacts with the emoji in the URL, as the bot', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 204 }));
    expect(await discordAbilities.react(fetchFn, auth, { chatId: 'C1', messageId: 'M1' }, '👀')).toEqual({ status: 'ok', value: {} });
    expect(await discordAbilities.unreact(fetchFn, auth, { chatId: 'C1', messageId: 'M1' }, '👀')).toEqual({ status: 'ok', value: undefined });
    expect(calls.map((call) => [call.method, call.url, call.auth])).toEqual([
      ['PUT', 'https://discord.com/api/v10/channels/C1/messages/M1/reactions/%F0%9F%91%80/@me', 'Bot bot-token'],
      ['DELETE', 'https://discord.com/api/v10/channels/C1/messages/M1/reactions/%F0%9F%91%80/@me', 'Bot bot-token'],
    ]);
  });

  it('says why a reaction failed (a missing permission)', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 403, body: { message: 'Missing Permissions' } }));
    expect(await discordAbilities.react(fetchFn, auth, { chatId: 'C1', messageId: 'M1' }, '👍')).toEqual({ status: 'failed', error: 'Discord reaction failed: Missing Permissions' });
  });

  it('reads history before a message id or a time, at most 100, oldest first', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: [
      { id: '2', timestamp: '2026-10-22T10:01:00.000Z', content: 'second', author: { id: 'U2', username: 'bob', global_name: 'Bob' }, mentions: [] },
      { id: '1', timestamp: '2026-10-22T10:00:00.000Z', content: 'first', author: { id: 'U1', username: 'amy' }, mentions: [] },
    ] }));
    const found = await discordAbilities.history(fetchFn, auth, { chatId: 'C1', threadId: 'C1', beforeId: '900', limit: 500 });
    expect(found.status === 'ok' && found.value.map((message) => [message.text, message.author.name])).toEqual([['first', 'amy'], ['second', 'Bob']]);
    expect(calls[0]?.url).toBe('https://discord.com/api/v10/channels/C1/messages?limit=100&before=900');
    await discordAbilities.history(fetchFn, auth, { chatId: 'C1', threadId: 'C1', beforeAt: '2026-10-22T10:00:00Z', limit: 5 });
    const snowflake = ((BigInt(Date.parse('2026-10-22T10:00:00Z')) - 1420070400000n) << 22n).toString();
    expect(calls[1]?.url).toBe('https://discord.com/api/v10/channels/C1/messages?limit=5&before=' + snowflake);
  });

  it('fails history when the bot may not read the channel', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 403, body: { message: 'Missing Access' } }));
    expect((await discordAbilities.history(fetchFn, auth, { chatId: 'C1', threadId: 'C1' })).status).toBe('failed');
  });
});

describe('Slack', () => {
  const auth = { token: 'xoxb-token' };

  it('reacts by short name and unreacts; asking twice is fine', async () => {
    const { fetchFn, calls } = fakeFetch((call) => ({ body: call.url.endsWith('reactions.add') ? { ok: false, error: 'already_reacted' } : { ok: true } }));
    expect(await slackAbilities.react(fetchFn, auth, MSG, '👍')).toEqual({ status: 'ok', value: {} });
    expect(await slackAbilities.unreact(fetchFn, auth, MSG, '👍')).toEqual({ status: 'ok', value: undefined });
    expect(calls.map((call) => [call.url, call.auth, call.body])).toEqual([
      ['https://slack.com/api/reactions.add', 'Bearer xoxb-token', { channel: 'C1', timestamp: '1700000000.000100', name: '+1' }],
      ['https://slack.com/api/reactions.remove', 'Bearer xoxb-token', { channel: 'C1', timestamp: '1700000000.000100', name: '+1' }],
    ]);
  });

  it('skips an emoji Slack has no name for without calling Slack, and reports a missing scope', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: { ok: false, error: 'missing_scope' } }));
    expect(await slackAbilities.react(fetchFn, auth, MSG, '🦄')).toEqual({ status: 'skipped', reason: 'Slack has no 🦄 reaction' });
    expect(calls).toHaveLength(0);
    expect(await slackAbilities.react(fetchFn, auth, MSG, '🎉')).toEqual({ status: 'failed', error: 'Slack reaction failed: missing_scope' });
  });

  it('reads history up to a time with the limit, and fails when Slack refuses', async () => {
    const { fetchFn, calls } = fakeFetch((call) => ({ body: call.url.includes('users.info')
      ? { ok: true, user: { id: 'U1', name: 'amy', profile: { display_name: 'Amy' } } }
      : { ok: true, messages: [{ ts: '1700000002.000000', user: 'U1', text: 'newer' }, { ts: '1700000001.000000', user: 'U1', text: 'older' }] } }));
    const found = await slackAbilities.history(fetchFn, auth, { chatId: 'C1', threadId: 'C1', beforeAt: '2026-10-22T10:00:00Z', limit: 7 });
    expect(found.status === 'ok' && found.value.map((message) => message.text)).toEqual(['older', 'newer']);
    expect(calls[0]?.url).toBe('https://slack.com/api/conversations.history?channel=C1&latest=' + (Date.parse('2026-10-22T10:00:00Z') / 1000).toFixed(6) + '&limit=7');
    const refused = fakeFetch(() => ({ body: { ok: false, error: 'missing_scope' } }));
    expect((await slackAbilities.history(refused.fetchFn, auth, { chatId: 'C1', threadId: 'C1' })).status).toBe('failed');
  });
});

describe('Telegram', () => {
  const auth = { token: '123:abc' };

  it('reacts with the canonical emoji of its own list', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: { ok: true, result: true } }));
    expect(await telegramAbilities.react(fetchFn, auth, { chatId: '-100', messageId: '42' }, '❤️')).toEqual({ status: 'ok', value: {} });
    expect(calls[0]).toMatchObject({ url: 'https://api.telegram.org/bot123:abc/setMessageReaction', method: 'POST', body: { chat_id: '-100', message_id: 42, reaction: [{ type: 'emoji', emoji: '❤' }] } });
  });

  it('skips an emoji outside its list, and has no history', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: { ok: true } }));
    expect(await telegramAbilities.react(fetchFn, auth, { chatId: '-100', messageId: '42' }, '🦄')).toEqual({ status: 'skipped', reason: 'Telegram has no 🦄 reaction' });
    expect(await telegramAbilities.history(fetchFn, auth, { chatId: '-100', threadId: '-100' })).toEqual({ status: 'unsupported' });
    expect(calls).toHaveLength(0);
  });
});

describe('Feishu', () => {
  const answer = (call: Call): { body?: unknown } => call.url.endsWith('/tenant_access_token/internal')
    ? { body: { code: 0, tenant_access_token: 't-1', expire: 7200 } }
    : { body: { code: 0, data: { reaction_id: 'R1' } } };

  it('reacts with a Feishu emoji type and takes it back by reaction id', async () => {
    const { fetchFn, calls } = fakeFetch(answer);
    const auth = { token: 'secret', appId: 'cli_react', domain: 'feishu' as const };
    expect(await feishuAbilities.react(fetchFn, auth, { chatId: 'oc_1', messageId: 'om_1' }, '👍')).toEqual({ status: 'ok', value: { reactionId: 'R1' } });
    expect(await feishuAbilities.unreact(fetchFn, auth, { chatId: 'oc_1', messageId: 'om_1' }, '👍', 'R1')).toEqual({ status: 'ok', value: undefined });
    expect(await feishuAbilities.unreact(fetchFn, auth, { chatId: 'oc_1', messageId: 'om_1' }, '👍')).toEqual({ status: 'unsupported' });
    const api = calls.filter((call) => !call.url.endsWith('/tenant_access_token/internal'));
    expect(api.map((call) => [call.method, call.url, call.auth, call.body])).toEqual([
      ['POST', 'https://open.feishu.cn/open-apis/im/v1/messages/om_1/reactions', 'Bearer t-1', { reaction_type: { emoji_type: 'THUMBSUP' } }],
      ['DELETE', 'https://open.feishu.cn/open-apis/im/v1/messages/om_1/reactions/R1', 'Bearer t-1', {}],
    ]);
    expect(await feishuAbilities.react(fetchFn, auth, { chatId: 'oc_1', messageId: 'om_1' }, '🦄')).toEqual({ status: 'skipped', reason: 'Feishu has no 🦄 reaction' });
  });

  it('reads a group\'s text messages: newest first from Feishu, the waking message left out, mentions as @Name', async () => {
    const item = (id: string, ms: number, text: string, sender = 'ou_a') => ({ message_id: id, create_time: String(ms), msg_type: 'text', body: { content: JSON.stringify({ text }) }, sender: { id: sender, sender_type: 'user' }, mentions: [{ key: '@_user_1', id: 'ou_b', name: 'Bea' }] });
    const { fetchFn, calls } = fakeFetch((call) => call.url.endsWith('/tenant_access_token/internal')
      ? { body: { code: 0, tenant_access_token: 't-2', expire: 7200 } }
      : { body: { code: 0, data: { items: [
        item('om_trigger', 3000, '@bot help'),
        item('om_3', 2000, 'ping @_user_1', 'ou_b'),
        { message_id: 'om_img', create_time: '1500', msg_type: 'image', body: { content: '{}' }, sender: { id: 'ou_a' } },
        item('om_1', 1000, 'hello'),
      ] } } });
    const found = await feishuAbilities.history(fetchFn, { token: 'secret', appId: 'cli_hist' }, { chatId: 'oc_1', threadId: 'oc_1', beforeId: 'om_trigger', limit: 10 });
    expect(found.status === 'ok' && found.value.map((message) => [message.id, message.text, message.author.name, message.at])).toEqual([
      ['om_1', 'hello', 'someone', '1970-01-01T00:00:01.000Z'],
      ['om_3', 'ping @Bea', 'Bea', '1970-01-01T00:00:02.000Z'],
    ]);
    expect(calls.at(-1)?.url).toBe('https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=oc_1&sort_type=ByCreateTimeDesc&page_size=11');
  });

  it('fails history when the app lacks the permission', async () => {
    const { fetchFn } = fakeFetch((call) => call.url.endsWith('/tenant_access_token/internal')
      ? { body: { code: 0, tenant_access_token: 't-3', expire: 7200 } }
      : { body: { code: 99991672, msg: 'Access denied. scope im:message.group_msg' } });
    const found = await feishuAbilities.history(fetchFn, { token: 'secret', appId: 'cli_denied' }, { chatId: 'oc_1', threadId: 'oc_1' });
    expect(found).toMatchObject({ status: 'failed' });
  });
});

describe('declared capabilities', () => {
  it('Telegram has no history; Discord and Slack read it; Discord reacts with any emoji since the install asks for ADD_REACTIONS', () => {
    expect(telegramAdapter.capabilities([]).history).toEqual({ window: false, onDemand: false, beforeJoin: false });
    expect(discordAdapter.capabilities([]).history).toEqual({ window: true, onDemand: true, beforeJoin: true });
    expect(slackAdapter.capabilities([]).history.onDemand).toBe(true);
    expect(discordAdapter.capabilities([]).reactions).toEqual({ mode: 'any' });
  });

  it('Feishu has neither history nor reactions until the optional permissions were granted, and a grant of another platform changes nothing', () => {
    const feishu = feishuAdapter.capabilities;
    expect(feishu([]).history.onDemand).toBe(false);
    expect(feishu([]).reactions.mode).toBe('none');
    expect(feishu(['im:message.history:readonly']).history.onDemand).toBe(false);
    expect(feishu([FEISHU_SCOPE_GROUP_MESSAGES]).history.onDemand).toBe(true);
    expect(feishu([FEISHU_SCOPE_REACTIONS]).reactions.mode).toBe('limited');
    expect(slackAdapter.capabilities([FEISHU_SCOPE_GROUP_MESSAGES])).toEqual(slackAdapter.capabilities([]));
  });

  it('a limited reaction set matches an emoji with or without its variation selector', () => {
    const slack = slackAdapter.capabilities([]).reactions;
    expect(reactionAllowed(slack, '❤')).toBe(true);
    expect(reactionAllowed(slack, '❤️')).toBe(true);
    expect(reactionAllowed(slack, '🦄')).toBe(false);
    expect(reactionAllowed(discordAdapter.capabilities([]).reactions, '🦄')).toBe(true);
  });
});

describe('every platform', () => {
  it('matches the capability table: history or reactions where the table gives them, and files both ways (the calls are in files.test.ts)', async () => {
    const { fetchFn } = fakeFetch(() => ({ body: { ok: false } }));
    for (const kind of Object.keys(CHANNEL_PLATFORMS)) {
      const caps = CHANNEL_PLATFORMS[kind]!.capabilities([]);
      const history = await CHANNEL_PLATFORMS[kind]?.abilities.history(fetchFn, { token: 't', appId: 'a' }, { chatId: 'c', threadId: 'c' });
      // Telegram: the table says no history and the ability is unsupported. Feishu: closed until granted, but the ability exists. The others have it.
      expect({ kind, supported: history?.status !== 'unsupported' }).toEqual({ kind, supported: kind !== 'telegram' });
      expect({ kind, history: caps.history.onDemand }).toEqual({ kind, history: kind === 'discord' || kind === 'slack' });
      expect({ kind, files: caps.files.read && caps.files.send }).toEqual({ kind, files: true });
    }
  });
});

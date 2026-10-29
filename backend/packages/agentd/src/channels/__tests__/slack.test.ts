/**
 * CH3 Slack: Events API parser, sender thread routing and the connector (fake fetch, no network).
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { encryptSecret } from '@agent-desktop/contracts/secrets';
import type { ChannelRow } from '@agent-desktop/contracts';
import { parseSlackEvent } from '@agent-desktop/channels/slack/api';
import { createSlackSender } from '@agent-desktop/channels/slack/send';
import { slackConnector } from '../slack/connect.js';
import { fetchGroupHistory } from '../history.js';
import { channelConversationId, channelItemId } from '../../routes/channels.js';
import type { AgentdDeps } from '../../routes/index.js';
import { testChannels } from '../../__tests__/test-app.js';

const BOT = 'UBOT';

function callback(event: Record<string, unknown>): unknown {
  return { type: 'event_callback', event_id: 'Ev1', event: { channel: 'D1', user: 'U7', ts: '100.1', text: 'hi', ...event } };
}

describe('parseSlackEvent', () => {
  it('maps a DM to a private event keyed by the channel', () => {
    expect(parseSlackEvent(callback({ type: 'message', channel_type: 'im' }), BOT)).toEqual({
      chatId: 'D1', chatType: 'private', threadId: 'D1', externalMessageId: 'D1:100.1', from: { id: 'U7', name: '' }, text: 'hi',
    });
  });

  it('strips the mention and replies in a thread under the mention', () => {
    const event = parseSlackEvent(callback({ type: 'app_mention', channel: 'C1', text: '<@UBOT> do it' }), BOT);
    expect(event).toMatchObject({ chatId: 'C1', chatType: 'group', threadId: 'C1:100.1', text: 'do it' });
    const inThread = parseSlackEvent(callback({ type: 'app_mention', channel: 'C1', thread_ts: '50.0', text: '<@UBOT> again' }), BOT);
    expect(inThread?.threadId).toBe('C1:50.0');
  });

  it('ignores bot messages, the bot itself, subtypes and other events', () => {
    expect(parseSlackEvent(callback({ type: 'message', channel_type: 'im', bot_id: 'B1' }), BOT)).toBeNull();
    expect(parseSlackEvent(callback({ type: 'message', channel_type: 'im', user: BOT }), BOT)).toBeNull();
    expect(parseSlackEvent(callback({ type: 'message', channel_type: 'im', subtype: 'message_changed' }), BOT)).toBeNull();
    expect(parseSlackEvent(callback({ type: 'message', channel_type: 'channel' }), BOT)).toBeNull();
    expect(parseSlackEvent({ type: 'url_verification', challenge: 'x' }, BOT)).toBeNull();
  });
});

describe('Slack group mention threading and context', () => {
  it('replies in the mention\'s own thread: a top-level mention starts one, a thread mention stays in it', () => {
    expect(parseSlackEvent(callback({ type: 'app_mention', channel: 'C1', ts: '200.1', text: '<@UBOT> hi' }), BOT)?.threadId).toBe('C1:200.1');
    expect(parseSlackEvent(callback({ type: 'app_mention', channel: 'C1', ts: '200.5', thread_ts: '200.1', text: '<@UBOT> hi' }), BOT)?.threadId).toBe('C1:200.1');
  });

  it('fetches the thread, else the channel history, oldest first with display names', async () => {
    const urls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      urls.push(url.pathname.slice(5));
      if (url.pathname.endsWith('conversations.replies')) return Response.json({ ok: true, messages: [{ user: 'U1', text: 'root', ts: '200.1' }, { user: 'U7', text: 'me', ts: '200.5' }] });
      if (url.pathname.endsWith('users.info')) return Response.json({ ok: true, user: { profile: { display_name: 'Ana' } } });
      return Response.json({ ok: false });
    };
    const store = createMemoryStore();
    vi.stubEnv('SECRETS_KEY', Buffer.alloc(32, 5).toString('base64'));
    const row = { id: 'slack:s1', kind: 'slack', channelId: 's1', botToken: encryptSecret('xoxb-1') } as unknown as ChannelRow;
    const text = await fetchGroupHistory({ store, channels: testChannels, channelFetch: fetchFn }, row, { chatId: 'C1', threadId: 'C1:200.1', externalMessageId: 'C1:200.5' });
    expect(text).toBe('Ana: root');
    expect(urls).toContain('conversations.replies');
  });

  it('gives a later thread mention only the replies after the wake it already saw', async () => {
    const fetchFn: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith('conversations.replies')) {
        return Response.json({ ok: true, messages: [
          { user: 'U1', text: 'root', ts: '200.1' }, { user: 'U7', text: 'earlier mention', ts: '200.3' },
          { user: 'U1', text: 'new reply', ts: '200.4' }, { user: 'U7', text: 'this mention', ts: '200.5' },
        ] });
      }
      if (url.pathname.endsWith('users.info')) return Response.json({ ok: true, user: { profile: { display_name: 'Ana' } } });
      return Response.json({ ok: false });
    };
    vi.stubEnv('SECRETS_KEY', Buffer.alloc(32, 5).toString('base64'));
    const store = createMemoryStore().forOwner?.('owner-1');
    if (store === undefined) throw new Error('owner-scoped store is required');
    const row = { id: 'slack:s1', kind: 'slack', channelId: 's1', ownerId: 'owner-1', botToken: encryptSecret('xoxb-1') } as unknown as ChannelRow;
    const event = { chatId: 'C1', threadId: 'C1:200.1', externalMessageId: 'C1:200.5' };
    // Before any stored wake the whole thread comes (the trigger itself, 200.5, is never part of it).
    expect(await fetchGroupHistory({ store, channels: testChannels, channelFetch: fetchFn }, row, event)).toBe('Ana: root\nAna: earlier mention\nAna: new reply');
    const conversationId = channelConversationId('owner-1', 'slack', 's1', 'C1:200.1');
    await store.put('items', { id: channelItemId(conversationId, 'C1:200.3'), conversationId, type: 'user_message', at: '2026-10-22T00:00:00.000Z', authorId: 'owner-1', text: 'earlier mention', attachments: [], mentions: [] }, { conversationId });
    expect(await fetchGroupHistory({ store, channels: testChannels, channelFetch: fetchFn }, row, event)).toBe('Ana: new reply');
  });
});

describe('createSlackSender', () => {
  const channel = { botToken: 'xoxb-1' } as ChannelRow;
  function fake(response: Response) {
    const calls: Array<{ auth: string | null; body: Record<string, unknown> }> = [];
    const fetchFn: typeof fetch = async (_url, init) => {
      calls.push({ auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return response;
    };
    return { calls, sender: createSlackSender(fetchFn) };
  }

  it('posts into the thread when the threadId carries one, and not for a DM', async () => {
    const { calls, sender } = fake(Response.json({ ok: true, ts: '9.9' }));
    expect(await sender.sendText({ channel, chatId: 'C1', threadId: 'C1:100.1' }, 'yo')).toEqual({ ok: true, externalId: '9.9' });
    await sender.sendText({ channel, chatId: 'D1', threadId: 'D1' }, 'yo');
    expect(calls[0]).toEqual({ auth: 'Bearer xoxb-1', body: { channel: 'C1', text: 'yo', thread_ts: '100.1' } });
    expect(calls[1]?.body).toEqual({ channel: 'D1', text: 'yo' });
  });

  it('reports ok:false errors and rate limits', async () => {
    const failed = await fake(Response.json({ ok: false, error: 'channel_not_found' })).sender.sendText({ channel, chatId: 'C1', threadId: 'C1' }, 'x');
    expect(failed).toEqual({ ok: false, error: 'Slack send failed: channel_not_found' });
    const limited = await fake(new Response('', { status: 429, headers: { 'retry-after': '7' } })).sender.sendText({ channel, chatId: 'C1', threadId: 'C1' }, 'x');
    expect(limited.ok === false && limited.error).toContain('retry after 7');
  });
});

describe('slackConnector', () => {
  it('connects only through the shared Juno app: a pasted token, a manifest or a prepare step is refused', async () => {
    for (const body of [{ mode: 'manual', channelId: 'sabcdefghijkl', botToken: 'x', signingSecret: 'y' }, { mode: 'prepare' }, { mode: 'manifest' }, {}]) {
      expect(await slackConnector.connect({ deps: {} as AgentdDeps, ownerId: 'o', agentId: 'a', body })).toMatchObject({ ok: false, status: 400, code: 'UNSUPPORTED_CONNECT_MODE' });
    }
  });
});

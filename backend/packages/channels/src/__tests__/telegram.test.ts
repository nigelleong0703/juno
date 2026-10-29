/**
 * CH2 Telegram update parser: what becomes a channel event and what is ignored.
 */
import { describe, expect, it } from 'vitest';
import type { ChannelRow } from '@agent-desktop/contracts';
import { parseTelegramUpdate } from '../telegram/api.js';
import { createTelegramSender } from '../telegram/send.js';

const BOT = 'JunoBot';

function message(overrides: Record<string, unknown>): unknown {
  return {
    update_id: 1,
    message: {
      message_id: 11,
      from: { id: 7, is_bot: false, first_name: 'Ada', last_name: 'Lovelace' },
      chat: { id: 7, type: 'private' },
      text: 'hello',
      ...overrides,
    },
  };
}

describe('parseTelegramUpdate', () => {
  it('maps a private text message', () => {
    expect(parseTelegramUpdate(message({}), BOT)).toEqual({
      chatId: '7',
      chatType: 'private',
      threadId: '7',
      externalMessageId: '7:11',
      from: { id: '7', name: 'Ada Lovelace' },
      text: 'hello',
    });
  });

  it('keeps a group message that mentions the bot and strips the mention', () => {
    const event = parseTelegramUpdate(
      message({ chat: { id: -100, type: 'supergroup' }, text: '@junobot what is up', entities: [{ type: 'mention', offset: 0, length: 8 }] }),
      BOT,
    );
    expect(event?.chatType).toBe('group');
    expect(event?.text).toBe('what is up');
  });

  it('ignores group chatter that does not address the bot', () => {
    expect(parseTelegramUpdate(message({ chat: { id: -100, type: 'group' }, text: 'lunch?' }), BOT)).toBeNull();
  });

  it('puts a forum topic in its own thread', () => {
    const event = parseTelegramUpdate(
      message({ chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 5, text: '@JunoBot hi', entities: [{ type: 'mention', offset: 0, length: 8 }] }),
      BOT,
    );
    expect(event?.threadId).toBe('-100:5');
  });

  it('ignores non-text messages, edits and messages from bots', () => {
    expect(parseTelegramUpdate(message({ text: undefined }), BOT)).toBeNull();
    expect(parseTelegramUpdate({ update_id: 2, edited_message: { message_id: 1 } }, BOT)).toBeNull();
    expect(parseTelegramUpdate(message({ from: { id: 8, is_bot: true, first_name: 'Bot' } }), BOT)).toBeNull();
  });
});

describe('Telegram group reply', () => {
  it('replies to the message that addressed the bot', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn: typeof fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return Response.json({ ok: true, result: { message_id: 5 } }); };
    const channel = { botToken: 't' } as ChannelRow;
    await createTelegramSender(fetchFn).sendText({ channel, chatId: '-100', threadId: '-100', chatType: 'group', replyToMessageId: '11' }, 'yo');
    await createTelegramSender(fetchFn).sendRich!({ channel, chatId: '-100', threadId: '-100', chatType: 'group', replyToMessageId: '11' }, { text: 'yo', buttons: [] } as never);
    await createTelegramSender(fetchFn).sendText({ channel, chatId: '7', threadId: '7' }, 'dm');
    expect(bodies[0]).toMatchObject({ reply_parameters: { message_id: 11 } });
    expect(bodies[1]).toMatchObject({ reply_parameters: { message_id: 11 } });
    expect(bodies[2]).not.toHaveProperty('reply_parameters');
  });
});

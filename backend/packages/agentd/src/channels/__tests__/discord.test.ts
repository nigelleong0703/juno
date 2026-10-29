/**
 * Discord adapter: message parser and reply sender chunking. No network: REST goes through a fake fetch.
 */
import { describe, expect, it } from 'vitest';
import type { ChannelRow } from '@agent-desktop/contracts';
import { createDiscordSender, parseDiscordMessage } from '@agent-desktop/channels/discord/api';

const BOT = '555';

function msg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm1',
    channel_id: 'c1',
    content: 'hello',
    author: { id: 'u1', username: 'ann', global_name: 'Ann' },
    mentions: [],
    ...overrides,
  };
}

describe('parseDiscordMessage', () => {
  it('keeps a DM as a private chat keyed by its channel', () => {
    expect(parseDiscordMessage(msg(), BOT)).toEqual({
      chatId: 'c1', chatType: 'private', threadId: 'c1', externalMessageId: 'm1', from: { id: 'u1', name: 'Ann', handle: 'ann' }, text: 'hello',
    });
  });

  it('reads other users\' mentions as @Name (nick, then display name, then username) and keeps the handle', () => {
    const event = parseDiscordMessage(msg({
      guild_id: 'g1',
      content: '<@555> ask <@7> and <@!8> and <@9> in <#42>',
      mentions: [
        { id: BOT },
        { id: '7', username: 'nigelleong0703', global_name: 'Robin', member: { nick: 'Boss' } },
        { id: '8', username: 'cy', global_name: 'Cy' },
        { id: '9', username: 'dee' },
      ],
    }), BOT);
    expect(event?.text).toBe('ask @Boss and @Cy and @dee in <#42>');
    expect(event?.mentions).toEqual([
      { id: '7', name: 'Boss', handle: 'nigelleong0703' },
      { id: '8', name: 'Cy', handle: 'cy' },
      { id: '9', name: 'dee', handle: 'dee' },
    ]);
  });

  it('keeps a guild mention and strips both mention forms', () => {
    const event = parseDiscordMessage(msg({ guild_id: 'g1', content: '<@555> hi <@!555> there', mentions: [{ id: BOT }] }), BOT);
    expect(event).toMatchObject({ chatType: 'group', text: 'hi  there' });
  });

  it('ignores a guild message that does not address the bot', () => {
    expect(parseDiscordMessage(msg({ guild_id: 'g1', content: 'chatter', mentions: [{ id: '9' }] }), BOT)).toBeNull();
  });

  it('keeps a reply to the bot', () => {
    const event = parseDiscordMessage(msg({ guild_id: 'g1', referenced_message: { author: { id: BOT } } }), BOT);
    expect(event?.chatType).toBe('group');
  });

  it('ignores bot authors, webhooks and empty content', () => {
    expect(parseDiscordMessage(msg({ author: { id: 'b', bot: true } }), BOT)).toBeNull();
    expect(parseDiscordMessage(msg({ webhook_id: 'w' }), BOT)).toBeNull();
    expect(parseDiscordMessage(msg({ content: '  ' }), BOT)).toBeNull();
    expect(parseDiscordMessage(msg({ guild_id: 'g1', content: '<@555>', mentions: [{ id: BOT }] }), BOT)).toBeNull();
  });
});

describe('createDiscordSender', () => {
  const target = { channel: { botToken: 'tok' } as ChannelRow, chatId: 'c9', threadId: 'c9' };

  it('splits a long reply into 2000-char messages', async () => {
    const bodies: string[] = [];
    const fake: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://discord.com/api/v10/channels/c9/messages');
      expect((init?.headers as Record<string, string>)['authorization']).toBe('Bot tok');
      bodies.push((JSON.parse(String(init?.body)) as { content: string }).content);
      return Response.json({ id: 'sent-' + String(bodies.length) });
    };
    const res = await createDiscordSender(fake).sendText(target, 'a'.repeat(4500));
    expect(res).toEqual({ ok: true, externalId: 'sent-1', externalIds: ['sent-1', 'sent-2', 'sent-3'] });
    expect(bodies.map((b) => b.length)).toEqual([2000, 2000, 500]);
  });

  it('reports a rate limit with retry_after', async () => {
    const fake: typeof fetch = async () => Response.json({ message: 'You are being rate limited.', retry_after: 1.5 }, { status: 429 });
    const res = await createDiscordSender(fake).sendText(target, 'hi');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain('retry_after 1.5');
  });
});

/**
 * Mentions in both directions and the quote decision: inbound platform syntax read as `@Name` (per platform), outbound `@handle` /
 * `@Name` turned into the platform's syntax only when it resolves to exactly one known person.
 */
import { describe, expect, it } from 'vitest';
import { renderMentions, markMentions } from '../mentions.js';
import { shouldQuote } from '../quote.js';
import { discordOthersAfter, replyLine, rewriteDiscordRoles } from '../discord/api.js';
import { fetchDiscordHistory } from '../discord/history.js';
import { resolveSlackMentions } from '../slack/mentions.js';
import { parseTelegramUpdate } from '../telegram/api.js';
import { parseFeishuMessage } from '../feishu/api.js';
import { slackMessages } from '../slack/render.js';
import { discordMessages } from '../discord/render.js';
import { feishuCard } from '../feishu/render.js';
import type { ChannelPerson, ChannelSendTarget } from '../types.js';
import type { RichMessage } from '../render.js';

const robin: ChannelPerson = { id: '111', name: 'Robin', handle: 'nigelleong0703' };
const ann: ChannelPerson = { id: '222', name: 'Ann', handle: 'ann_w' };
const rich = (text: string): RichMessage => ({ text, buttons: [], questions: [], ownerOnly: false });
const slackStyle = (text: string, people: ChannelPerson[] = [robin, ann]): string => renderMentions(markMentions(text, people), (p) => `<@${p.id}>`);

describe('outbound mentions', () => {
  it('resolves a handle or a unique name, case-insensitively, and leaves the rest as text', () => {
    expect(slackStyle('hi @nigelleong0703 and @ann, also @bob and a@b.com')).toBe('hi <@111> and <@222>, also @bob and a@b.com');
  });

  it('does not resolve a name two people share, but still resolves each by handle', () => {
    const people = [robin,{ id: '333', name: 'Robin', handle: 'fake_robin' }];
    expect(slackStyle('@Robin look', people)).toBe('@Robin look');
    expect(slackStyle('@nigelleong0703 look', people)).toBe('<@111> look');
    expect(slackStyle('@fake_robin look', people)).toBe('<@333> look');
  });

  it('never lets a stranger whose name equals the owner\'s become a mention of the owner by name', () => {
    const owner = { id: '111', name: 'Robin', handle: 'nigelleong0703' };
    const imposter = { id: '999', name: 'Robin' };
    expect(slackStyle('@Robin', [owner, imposter])).toBe('@Robin');
  });

  it('survives the markdown converters: Slack escapes < and >, a card uses its own at-tag', () => {
    expect(slackMessages(rich('ping @ann_w now'))[0]?.blocks[0]).toMatchObject({ text: { text: 'ping @ann_w now' } });
    const marked = rich(markMentions('ping @ann_w now', [ann]));
    expect(slackMessages(marked)[0]?.blocks[0]).toMatchObject({ text: { text: 'ping <@222> now' } });
    expect(discordMessages(marked)[0]?.content).toBe('ping <@222> now');
    expect(JSON.stringify(feishuCard(marked))).toContain('ping <at id=222></at> now');
  });

  it('reads an unrendered placeholder as plain @Name', () => {
    expect(renderMentions(markMentions('hi @ann_w', [ann]))).toBe('hi @Ann');
  });
});

describe('quote decision', () => {
  it('never quotes in a private chat', () => {
    expect(shouldQuote({ chatType: 'private', triggerId: '5', othersAfter: true })).toBe(false);
  });
  it('does not quote when only our own app posted after the trigger (e.g. an acknowledgement bubble)', () => {
    expect(shouldQuote({ chatType: 'group', triggerId: '5', othersAfter: false })).toBe(false);
  });
  it('quotes when someone else posted after, and when that is unknown', () => {
    expect(shouldQuote({ chatType: 'group', triggerId: '5', othersAfter: true })).toBe(true);
    expect(shouldQuote({ chatType: 'group', triggerId: '5' })).toBe(true);
  });
  it('has nothing to quote without a trigger', () => {
    expect(shouldQuote({ chatType: 'group', othersAfter: true })).toBe(false);
  });
});

describe('Discord: did anyone but our app post after the trigger', () => {
  const ours = { botUserId: 'BOT', webhookIds: new Set(['W1']) };
  const reply = (messages: unknown): typeof fetch => async () => Response.json(messages);
  it('ignores our bot and our webhooks, counts everyone else', async () => {
    expect(await discordOthersAfter(reply([{ author: { id: 'BOT' } }, { author: { id: 'W1' }, webhook_id: 'W1' }]), 't', 'C1', '5', ours)).toBe(false);
    expect(await discordOthersAfter(reply([{ author: { id: 'BOT' } }, { author: { id: 'U2' } }]), 't', 'C1', '5', ours)).toBe(true);
    expect(await discordOthersAfter(reply([{ author: { id: 'X' }, webhook_id: 'W9' }]), 't', 'C1', '5', ours)).toBe(true);
  });
  it('is unknown when the lookup fails', async () => {
    expect(await discordOthersAfter(async () => new Response('no', { status: 500 }), 't', 'C1', '5', ours)).toBeUndefined();
  });
});

describe('Discord reply line', () => {
  const target = { chatId: 'C1', replyToMessageId: 'M1', replyToUserId: 'U1' } as unknown as ChannelSendTarget;
  it('names the asker and links the original', () => {
    expect(replyLine(target, 'G1')).toBe('-# ↪ replying to <@U1> · https://discord.com/channels/G1/C1/M1');
  });
  it('is absent when nothing is quoted', () => {
    expect(replyLine({ chatId: 'C1' } as unknown as ChannelSendTarget, 'G1')).toBeUndefined();
  });
});

describe('inbound mentions', () => {
  it('Slack: <@U…> and <@U…|name> read as @Name, via lookup or the embedded label', async () => {
    const lookups: string[] = [];
    const nameOf = async (id: string): Promise<string> => { lookups.push(id); return id === 'U1' ? 'Robin' : id; };
    const out = await resolveSlackMentions(nameOf, 'ask <@U1> and <@U2|Cy> about <#C1|general>');
    expect(out.text).toBe('ask @Robin and @Cy about <#C1|general>');
    expect(out.mentions).toEqual([{ id: 'U1', name: 'Robin' }, { id: 'U2', name: 'Cy' }]);
    expect(lookups).toEqual(['U1']);
  });

  it('Telegram: text_mention entities read as @Name with the handle; the bot mention is stripped; @username stays', () => {
    const text = '@bot_x ask Dana and @carl';
    const event = parseTelegramUpdate({
      update_id: 1,
      message: {
        message_id: 5, chat: { id: -1, type: 'supergroup' }, from: { id: 7, first_name: 'Ann', username: 'ann_w' }, text,
        entities: [
          { type: 'mention', offset: 0, length: 6 },
          { type: 'text_mention', offset: 11, length: 4, user: { id: 8, first_name: 'Dana', last_name: 'Q', username: 'dq' } },
          { type: 'mention', offset: 20, length: 5 },
        ],
      },
    }, 'bot_x');
    expect(event?.text).toBe('ask @Dana Q and @carl');
    expect(event?.mentions).toEqual([{ id: '8', name: 'Dana Q', handle: 'dq' }]);
    expect(event?.from).toEqual({ id: '7', name: 'Ann', handle: 'ann_w' });
  });

  it('Discord role mentions read @Name for a known agent role and @role for an unknown one, never the raw tag', () => {
    const names = new Map([['R1', 'Nova']]);
    expect(rewriteDiscordRoles('<@&R1> and <@&R9> please, <@&R1>?', names)).toBe('@Nova and @role please, @Nova?');
    expect(rewriteDiscordRoles('<@&123456> hi')).toBe('@role hi');
    expect(rewriteDiscordRoles('plain <@42> and <#7> stay')).toBe('plain <@42> and <#7> stay');
  });

  it('Discord history lines read role and user mentions as @Name', async () => {
    const messages = [
      { id: '2', content: '<@&R1> ask <@7> and <@&R9>', author: { id: 'u1', username: 'ann', global_name: 'Ann' }, mentions: [{ id: '7', username: 'dee' }], mention_roles: ['R1', 'R9'] },
    ];
    const fetchFn: typeof fetch = async () => Response.json(messages);
    const history = await fetchDiscordHistory(fetchFn, 'tok', { chatId: 'c1', threadId: 'c1', beforeId: '3', roleNames: new Map([['R1', 'Nova']]) });
    expect(history?.map((message) => message.text)).toEqual(['@Nova ask @dee and @role']);
  });

  it('Feishu: @_user_N placeholders read as @Name, the bot\'s own is stripped', () => {
    const event = parseFeishuMessage({
      sender: { sender_id: { open_id: 'ou_a' }, sender_type: 'user' },
      message: {
        message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 please ask @_user_2' }),
        mentions: [{ key: '@_user_1', name: 'Juno', id: { open_id: 'ou_bot' } }, { key: '@_user_2', name: 'Li Wei', id: { open_id: 'ou_li' } }],
      },
    }, 'ou_bot');
    expect(event?.text).toBe('please ask @Li Wei');
    expect(event?.mentions).toEqual([{ id: 'ou_li', name: 'Li Wei' }]);
  });
});

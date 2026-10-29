/**
 * Rich channel messages: the platform-neutral model from items and requests, the markdown each platform needs, and
 * the payload shape each platform's sender builds (no network).
 */
import { describe, expect, it } from 'vitest';
import type { StoredRequest } from '@agent-desktop/contracts';
import type { Item } from '@agent-desktop/public-contracts';
import { chunkMarkdown, convertMarkdown, parseButtonToken, plainText, richFromItem, richFromRequest, SLACK_MRKDWN, TELEGRAM_HTML } from '../render.js';
import { sendTelegramRich } from '../telegram/send.js';
import { telegramKeyboard } from '../telegram/render.js';
import { slackMessages } from '../slack/render.js';
import { discordComponents, discordMessages } from '../discord/render.js';
import { feishuCard } from '../feishu/render.js';
import type { ChannelRow } from '@agent-desktop/contracts';

type AgentMessage = Extract<Item, { type: 'agent_message' }>;
const AT = '2026-10-19T00:00:00.000Z';

function message(extra: Partial<AgentMessage>): AgentMessage {
  return { id: 'itm_1', conversationId: 'cvn', type: 'agent_message', agentId: 'a', markdown: 'Hello', citations: [], at: AT, ...extra };
}

function request(payload: StoredRequest['payload'], kind: StoredRequest['kind']): StoredRequest {
  return { id: 'req_1', status: 'pending', agentId: 'a', conversationId: 'cvn', kind, title: 'T', summary: 'S', payload, createdAt: AT } as StoredRequest;
}

describe('markdown conversion', () => {
  it('escapes Telegram HTML special characters and keeps formatting', () => {
    const html = convertMarkdown('# Title\n**bold** a < b & c > d `x<y` [site](https://e.com/?a=1&b=2)\n- one\n- two', TELEGRAM_HTML);
    expect(html).toBe('<b>Title</b>\n<b>bold</b> a &lt; b &amp; c &gt; d <code>x&lt;y</code> <a href="https://e.com/?a=1&amp;b=2">site</a>\n• one\n• two');
  });

  it('keeps a code fence verbatim but escaped, and puts a table in one', () => {
    expect(convertMarkdown('```ts\nif (a<b) {}\n```', TELEGRAM_HTML)).toBe('<pre><code class="language-ts">if (a&lt;b) {}</code></pre>');
    expect(convertMarkdown('| a | b |\n| - | - |\n| 1 | 2 |', SLACK_MRKDWN)).toBe('```\n| a | b |\n| - | - |\n| 1 | 2 |\n```');
  });

  it('writes Slack mrkdwn: escapes & < >, single-star bold, <url|label> links', () => {
    expect(convertMarkdown('## Hi\n**b** *i* ~~s~~ 1 < 2 & 3 > 2 [docs](https://x.dev/a?b=1&c=2)', SLACK_MRKDWN))
      .toBe('*Hi*\n*b* _i_ ~s~ 1 &lt; 2 &amp; 3 &gt; 2 <https://x.dev/a?b=1&amp;c=2|docs>');
  });

  it('does not treat snake_case or math stars as italics', () => {
    expect(convertMarkdown('use my_var_name and 2*3*4', TELEGRAM_HTML)).toBe('use my_var_name and 2*3*4');
  });

  it('chunks at line boundaries within the limit and reopens a cut code fence', () => {
    const text = 'intro\n```js\n' + Array.from({ length: 40 }, (_, i) => 'line ' + String(i)).join('\n') + '\n```\noutro';
    const chunks = chunkMarkdown(text, 120);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(chunks[1]?.startsWith('```js')).toBe(true);
    expect(chunkMarkdown('x'.repeat(250), 100).every((chunk) => chunk.length <= 100)).toBe(true);
  });
});

describe('the platform-neutral model', () => {
  it('turns quick replies into buttons with stateless tokens', () => {
    const rich = richFromItem(message({ markdown: 'Pick one', ui: { version: 1, blocks: [{ type: 'replies', options: ['Yes', 'No'] }] } }));
    expect(rich.text).toBe('Pick one');
    expect(rich.buttons.map((button) => [button.label, button.value])).toEqual([['Yes', 'Yes'], ['No', 'No']]);
    expect(parseButtonToken(rich.buttons[1]?.id ?? '')).toEqual({ kind: 'item', id: 'itm_1', index: 1 });
    expect(rich.buttons.every((button) => new TextEncoder().encode(button.id).length <= 64)).toBe(true);
    expect(plainText(rich)).toBe('Pick one\n\n1) Yes\n2) No\nReply with the number or your own words.');
  });

  it('renders a card as markdown next to its lead-in, and replies alone get a body', () => {
    const rich = richFromItem(message({ markdown: 'Summary', ui: { version: 1, title: 'Trip', blocks: [{ type: 'facts', rows: [{ label: 'City', value: 'Oslo' }] }, { type: 'replies', options: ['Book'] }] } }));
    expect(rich.text).toBe('Summary\n\n**Trip**\n\n**City:** Oslo');
    expect(richFromItem(message({ markdown: '', ui: { version: 1, blocks: [{ type: 'replies', options: ['A'] }] } })).text).not.toBe('');
  });

  it('turns a choices question into buttons, a fields question into text prompts', () => {
    const choices = richFromRequest(request({ kind: 'question', ui: { version: 1, title: 'Which?', blocks: [{ type: 'choices', id: 'c', options: [{ id: 'a', label: 'Alpha', description: 'first' }, { id: 'b', label: 'Beta' }] }] } }, 'question'));
    expect(choices?.buttons.map((button) => button.label)).toEqual(['Alpha', 'Beta']);
    expect(choices?.ownerOnly).toBe(true);
    expect(choices?.text).toContain('1) Alpha — first');
    const fields = richFromRequest(request({ kind: 'question', ui: { version: 1, blocks: [{ type: 'fields', id: 'f', fields: [{ id: 'n', label: 'Name', kind: 'text' }, { id: 's', label: 'Size', kind: 'select', options: ['S', 'M'] }] }] } }, 'question'));
    expect(fields?.buttons).toEqual([]);
    expect(fields?.questions).toEqual([{ id: 'n', label: 'Name' }, { id: 's', label: 'Size', options: ['S', 'M'] }]);
    expect(fields?.text).toContain('2. Size: S / M');
  });

  it('turns an approval into approve / deny buttons, and points a button-less platform to the app', () => {
    const rich = richFromRequest(request({ kind: 'approval', action: 'Send email', target: 'a@b.co', why: 'You asked me to' }, 'approval'));
    expect(rich?.buttons.map((button) => [button.label, button.style])).toEqual([['Approve', 'primary'], ['Deny', 'danger']]);
    expect(rich?.approval).toEqual({ requestId: 'req_1' });
    expect(plainText(rich ?? { text: '', buttons: [], questions: [], ownerOnly: false })).toContain('Open the app');
    expect(richFromRequest(request({ kind: 'signin', site: 's', url: 'u', pausesModel: false }, 'signin'))).toBeUndefined();
  });
});

describe('platform payloads', () => {
  const rich = richFromItem(message({ markdown: 'Choose', ui: { version: 1, blocks: [{ type: 'replies', options: ['Yes', 'No', 'Maybe'] }] } }));

  it('Telegram: short buttons share a row, long ones do not', () => {
    expect(telegramKeyboard(rich.buttons).inline_keyboard.map((row) => row.map((cell) => cell.text))).toEqual([['Yes', 'No'], ['Maybe']]);
    expect(telegramKeyboard([{ ...rich.buttons[0]!, label: 'A rather long label here' }, rich.buttons[1]!]).inline_keyboard).toHaveLength(2);
  });

  it('Telegram: sends HTML with the keyboard on the last chunk, and falls back to plain text when parsing is refused', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchFn: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(body);
      if (calls.length === 1) return Response.json({ ok: false, description: "Bad Request: can't parse entities" }, { status: 400 });
      return Response.json({ ok: true, result: { message_id: 5 } });
    };
    const result = await sendTelegramRich(fetchFn, { channel: { botToken: 't' } as ChannelRow, chatId: 'c1', threadId: 'c1:7' }, rich);
    expect(result).toEqual({ ok: true, externalId: '5' });
    expect(calls[0]).toMatchObject({ chat_id: 'c1', message_thread_id: 7, text: 'Choose', parse_mode: 'HTML' });
    expect(calls[1]?.['parse_mode']).toBeUndefined();
    expect(calls[1]?.['reply_markup']).toEqual(telegramKeyboard(rich.buttons));
  });

  it('Slack: mrkdwn sections of at most 3000 characters and one actions block of buttons', () => {
    const long = richFromItem(message({ markdown: 'word '.repeat(2000), ui: { version: 1, blocks: [{ type: 'replies', options: ['Go'] }] } }));
    const [only] = slackMessages(long);
    expect(only?.blocks.filter((block) => block['type'] === 'section').length).toBeGreaterThan(2);
    for (const block of only?.blocks ?? []) if (block['type'] === 'section') expect(String((block['text'] as { text: string }).text).length).toBeLessThanOrEqual(3000);
    const last = only?.blocks[only.blocks.length - 1];
    expect(last).toMatchObject({ type: 'actions', elements: [{ type: 'button', action_id: long.buttons[0]?.id, text: { type: 'plain_text', text: 'Go' } }] });
    expect(slackMessages(rich)[0]?.blocks[0]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: 'Choose' } });
  });

  it('Discord: rows of five buttons carrying the token, text in pieces under 2000', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ id: 'jn:i:itm_1:' + String(i), label: 'B' + String(i), value: 'B', style: 'default' as const }));
    const rows = discordComponents(many);
    expect(rows.map((row) => (row['components'] as unknown[]).length)).toEqual([5, 2]);
    const messages = discordMessages({ ...rich, text: 'line\n'.repeat(900) });
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((m) => m.content.length <= 2000)).toBe(true);
    expect(messages[0]?.components).toBeUndefined();
    expect(messages[messages.length - 1]?.components).toBeDefined();
  });

  it('Feishu: a card with markdown elements and a row of buttons whose value is the token; chosen drops the buttons', () => {
    const card = feishuCard(rich);
    expect(card['elements']).toEqual([
      { tag: 'markdown', content: 'Choose' },
      { tag: 'action', actions: expect.arrayContaining([{ tag: 'button', text: { tag: 'plain_text', content: 'Yes' }, type: 'default', value: { t: rich.buttons[0]?.id } }]) },
    ]);
    expect(JSON.stringify(feishuCard(rich, 'Yes'))).not.toContain('"action"');
  });
});

/**
 * Rich messages on messaging platforms: one platform-neutral model, and the markdown each platform needs.
 *
 * An agent reply (`agent_message` with a card, quick replies) or a pending question / approval request becomes a
 * `RichMessage`: markdown text, tap buttons, text prompts for form fields. Each platform file turns that into its own
 * payload (Telegram HTML + inline keyboard, Slack Block Kit, Discord components, Feishu card). A platform that cannot
 * show buttons gets `plainText`: the same message with the options listed "1) ... 2) ...", answered by number or words.
 *
 * Button tokens carry no state: `jn:<i|q|a>:<id>:<index>` names the stored item or request and the option in it, so a tap
 * is re-read from the store (also the guard against a double tap) and the 64-byte Telegram limit is never an issue.
 */
import { uiDocToText, type Item, type UiBlock, type UiDoc } from '@agent-desktop/public-contracts';
import type { StoredRequest } from '@agent-desktop/contracts';
import { renderMentions } from './mentions.js';
import type { ChannelPerson } from './types.js';

export type ButtonStyle = 'primary' | 'danger' | 'default';

export interface RichButton {
  /** The callback token (`jn:...`). */
  id: string;
  label: string;
  /** What the user is taken to have said: the option label. */
  value: string;
  style: ButtonStyle;
}

/** A form field asked as a text prompt: the user answers in one message, one `Label: value` line per field. */
export interface RichQuestion {
  id: string;
  label: string;
  options?: string[];
}

export interface RichMessage {
  /** Markdown: lead-in and card. Never empty. */
  text: string;
  buttons: RichButton[];
  questions: RichQuestion[];
  /** Set for an approval: a tap needs the bound owner. */
  approval?: { requestId: string };
  /** The tap decides a request (question / approval): owner only. */
  ownerOnly: boolean;
}

export type ButtonKind = 'item' | 'question' | 'approval';

const KIND_CODE: Record<ButtonKind, string> = { item: 'i', question: 'q', approval: 'a' };
const TOKEN = /^jn:([iqa]):([A-Za-z0-9_-]{1,48}):(\d{1,2})$/;

export function buttonToken(kind: ButtonKind, id: string, index: number): string {
  return `jn:${KIND_CODE[kind]}:${id}:${String(index)}`;
}

export function parseButtonToken(token: string): { kind: ButtonKind; id: string; index: number } | undefined {
  const match = TOKEN.exec(token);
  if (match === null) return undefined;
  const kind = match[1] === 'i' ? 'item' : match[1] === 'q' ? 'question' : 'approval';
  return { kind, id: match[2] ?? '', index: Number(match[3]) };
}

/** Shown when a reply is only quick-reply buttons (a platform message needs some body). */
const BUTTONS_ONLY_TEXT = '👇';

// --- UI card as markdown ----------------------------------------------------

function blockMarkdown(block: UiBlock | Extract<UiBlock, { type: 'group' }>['blocks'][number]): string[] {
  switch (block.type) {
    case 'text':
      return [block.text];
    case 'facts':
      return block.rows.map((row) => `**${row.label}:** ${row.value}`);
    case 'items': {
      const lines = block.rows.map((row) => {
        const parts = [`- ${row.name}`];
        if (row.detail !== undefined) parts.push(` — ${row.detail}`);
        if (row.quantity !== undefined) parts.push(` ×${String(row.quantity)}`);
        if (row.price !== undefined) parts.push(` ${row.price}`);
        return parts.join('');
      });
      return block.total === undefined ? lines : [...lines, `**${block.total.label}:** ${block.total.value}`];
    }
    case 'table':
      return ['| ' + block.columns.join(' | ') + ' |', ...block.rows.map((row) => '| ' + row.join(' | ') + ' |')];
    case 'notice':
      return [`> ${block.text}`];
    case 'link':
      return [block.subtitle === undefined ? `[${block.title}](${block.url})` : `[${block.title}](${block.url}) — ${block.subtitle}`];
    case 'image':
      return block.caption === undefined ? [] : [`_${block.caption}_`];
    case 'group':
      return [...(block.title === undefined ? [] : [`**${block.title}**`]), ...block.blocks.flatMap(blockMarkdown)];
    case 'replies':
    case 'choices':
    case 'fields':
      return [];
  }
}

/** The display blocks of a card as markdown (title bold); interactive blocks are rendered as buttons / prompts instead. */
export function cardMarkdown(doc: UiDoc): string {
  const lines = doc.blocks.flatMap((block) => {
    const rendered = blockMarkdown(block);
    return rendered.length === 0 ? [] : [rendered.join('\n')];
  });
  const body = lines.join('\n\n');
  if (doc.title === undefined) return body;
  return body.length === 0 ? `**${doc.title}**` : `**${doc.title}**\n\n${body}`;
}

const STYLE_FOR: Record<string, ButtonStyle> = { primary: 'primary', destructive: 'danger', default: 'default' };

function fieldPrompt(field: Extract<UiBlock, { type: 'fields' }>['fields'][number]): RichQuestion {
  return { id: field.id, label: field.label, ...(field.options === undefined ? {} : { options: field.options }) };
}

/** The numbered text form of options (the fallback everywhere, and the descriptions next to buttons). */
function describedOptions(options: Array<{ label: string; description?: string }>): string {
  return options.map((option, index) => `${String(index + 1)}) ${option.label}${option.description === undefined ? '' : ' — ' + option.description}`).join('\n');
}

// --- items and requests -----------------------------------------------------

/** An agent reply: its lead-in, the card as markdown, and quick replies as buttons. */
export function richFromItem(item: Extract<Item, { type: 'agent_message' }>): RichMessage {
  const ui = item.ui;
  // A reply without a lead-in stores the card's plain text form as its markdown; the structured card replaces it.
  const leadIn = ui !== undefined && item.markdown === uiDocToText(ui) ? '' : item.markdown.trim();
  const card = ui === undefined ? '' : cardMarkdown(ui);
  const buttons: RichButton[] = [];
  for (const block of ui?.blocks ?? []) {
    if (block.type !== 'replies') continue;
    block.options.forEach((label, index) => buttons.push({ id: buttonToken('item', item.id, index), label, value: label, style: 'default' }));
  }
  const text = [leadIn, card].filter((part) => part.length > 0).join('\n\n');
  return { text: text.length > 0 ? text : BUTTONS_ONLY_TEXT, buttons, questions: [], ownerOnly: false };
}

/** A pending question or approval; other request kinds are not asked on a platform. */
export function richFromRequest(request: StoredRequest): RichMessage | undefined {
  const payload = request.payload;
  if (payload.kind === 'question') {
    const block = payload.ui.blocks.find((candidate) => candidate.type === 'choices' || candidate.type === 'fields');
    const parts = [cardMarkdown(payload.ui)];
    const buttons: RichButton[] = [];
    const questions: RichQuestion[] = [];
    if (block?.type === 'choices') {
      if (block.multiple === true) {
        parts.push(describedOptions(block.options), 'Reply with the numbers or names, separated by commas.');
      } else {
        block.options.forEach((option, index) => buttons.push({ id: buttonToken('question', request.id, index), label: option.label, value: option.label, style: STYLE_FOR[option.style ?? 'default'] ?? 'default' }));
        if (block.options.some((option) => option.description !== undefined)) parts.push(describedOptions(block.options));
      }
    } else if (block?.type === 'fields') {
      for (const field of block.fields) questions.push(fieldPrompt(field));
      parts.push(
        block.fields.map((field, index) => `${String(index + 1)}. ${field.label}${field.required === false ? ' (optional)' : ''}${field.options === undefined ? '' : ': ' + field.options.join(' / ')}`).join('\n'),
        'Reply in one message, one line per answer, like "' + (block.fields[0]?.label ?? 'Name') + ': ...".',
      );
    }
    const text = parts.filter((part) => part.length > 0).join('\n\n');
    return { text: text.length > 0 ? text : request.summary, buttons, questions, ownerOnly: true };
  }
  if (payload.kind === 'approval') {
    const head = `**${payload.action}**${payload.target === undefined ? '' : ' — ' + payload.target}`;
    const parts = [head, payload.why];
    if (payload.draft !== undefined) parts.push((payload.draft.subject === undefined ? '' : `**${payload.draft.subject}**\n`) + payload.draft.body);
    if (payload.ui !== undefined) parts.push(cardMarkdown(payload.ui));
    return {
      text: parts.filter((part) => part.length > 0).join('\n\n'),
      buttons: [
        { id: buttonToken('approval', request.id, 0), label: 'Approve', value: 'Approve', style: 'primary' },
        { id: buttonToken('approval', request.id, 1), label: 'Deny', value: 'Deny', style: 'danger' },
      ],
      questions: [],
      approval: { requestId: request.id },
      ownerOnly: true,
    };
  }
  return undefined;
}

/**
 * The message for a platform without buttons: the text, then the options as "1) ... 2) ..." the user answers by number or
 * words. An approval cannot be decided by typing, so it points to the app.
 */
export function plainText(rich: RichMessage): string {
  if (rich.buttons.length === 0) return rich.text;
  if (rich.approval !== undefined) return rich.text + '\n\nOpen the app to approve or deny this.';
  return rich.text + '\n\n' + describedOptions(rich.buttons) + '\nReply with the number or your own words.';
}

// --- markdown conversion ----------------------------------------------------

/** How one platform writes each markdown construct. */
export interface MarkdownFormat {
  escape(text: string): string;
  bold(inner: string): string;
  italic(inner: string): string;
  strike(inner: string): string;
  code(raw: string): string;
  link(label: string, url: string): string;
  fence(code: string, lang: string): string;
  quote(inner: string): string;
  bullet: string;
  /** The platform's mention syntax for a person marked by `markMentions`; absent: plain `@Name`. */
  mention?(person: ChannelPerson): string;
}

const INLINE = new RegExp(
  [
    '`([^`\\n]+)`', // 1 code
    '\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)', // 2 label, 3 url
    '\\*\\*(.+?)\\*\\*', // 4 bold
    '__(.+?)__', // 5 bold
    '~~(.+?)~~', // 6 strike
    '(?<![*\\w])\\*(?![\\s*])([^*\\n]+?)(?<![\\s*])\\*(?![*\\w])', // 7 italic
    '(?<![\\w_])_(?![\\s_])([^_\\n]+?)(?<![\\s_])_(?![\\w_])', // 8 italic
  ].join('|'),
  'g',
);

function inline(text: string, format: MarkdownFormat): string {
  let out = '';
  let last = 0;
  INLINE.lastIndex = 0;
  for (let match = INLINE.exec(text); match !== null; match = INLINE.exec(text)) {
    out += format.escape(text.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[1] !== undefined) out += format.code(match[1]);
    else if (match[2] !== undefined && match[3] !== undefined) out += format.link(match[2], match[3]);
    else if (match[4] !== undefined || match[5] !== undefined) out += format.bold(inline(match[4] ?? match[5] ?? '', format));
    else if (match[6] !== undefined) out += format.strike(inline(match[6], format));
    else out += format.italic(inline(match[7] ?? match[8] ?? '', format));
    INLINE.lastIndex = last;
  }
  return out + format.escape(text.slice(last));
}

const FENCE = /^\s*```(\S*)\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;

/** Markdown to one platform's dialect: headings become bold, tables a code block, lists bullets, links and code kept. */
export function convertMarkdown(markdown: string, format: MarkdownFormat): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const body: string[] = [];
      for (i += 1; i < lines.length && !FENCE.test(lines[i] ?? ''); i += 1) body.push(lines[i] ?? '');
      out.push(format.fence(body.join('\n'), fence[1] ?? ''));
      continue;
    }
    if (TABLE_ROW.test(line)) {
      const rows: string[] = [line.trim()];
      while (TABLE_ROW.test(lines[i + 1] ?? '')) { i += 1; rows.push((lines[i] ?? '').trim()); }
      out.push(format.fence(rows.join('\n'), ''));
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [QUOTE.exec(line)?.[1] ?? ''];
      while (QUOTE.test(lines[i + 1] ?? '')) { i += 1; quoted.push(QUOTE.exec(lines[i] ?? '')?.[1] ?? ''); }
      out.push(format.quote(quoted.map((quotedLine) => inline(quotedLine, format)).join('\n')));
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) { out.push(format.bold(inline(heading[1] ?? '', format))); continue; }
    if (RULE.test(line)) { out.push('———'); continue; }
    const bullet = BULLET.exec(line);
    if (bullet !== null) { out.push((bullet[1] ?? '') + format.bullet + inline(bullet[2] ?? '', format)); continue; }
    out.push(inline(line, format));
  }
  return renderMentions(out.join('\n'), format.mention);
}

/** Telegram's HTML parse mode: three characters to escape, against eighteen in MarkdownV2 where one miss rejects the message. */
const escapeHtml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export const TELEGRAM_HTML: MarkdownFormat = {
  escape: escapeHtml,
  bold: (inner) => `<b>${inner}</b>`,
  italic: (inner) => `<i>${inner}</i>`,
  strike: (inner) => `<s>${inner}</s>`,
  code: (raw) => `<code>${escapeHtml(raw)}</code>`,
  link: (label, url) => `<a href="${escapeHtml(url).replaceAll('"', '&quot;')}">${escapeHtml(label)}</a>`,
  fence: (code, lang) => `<pre>${lang === '' ? escapeHtml(code) : `<code class="language-${escapeHtml(lang.replace(/[^\w+#.-]/g, ''))}">${escapeHtml(code)}</code>`}</pre>`,
  quote: (inner) => `<blockquote>${inner}</blockquote>`,
  bullet: '• ',
};

/** Slack mrkdwn: `&`, `<` and `>` are the only characters Slack reads as markup. */
export const SLACK_MRKDWN: MarkdownFormat = {
  escape: escapeHtml,
  bold: (inner) => `*${inner}*`,
  italic: (inner) => `_${inner}_`,
  strike: (inner) => `~${inner}~`,
  code: (raw) => '`' + escapeHtml(raw) + '`',
  link: (label, url) => `<${escapeHtml(url)}|${escapeHtml(label)}>`,
  fence: (code) => '```\n' + escapeHtml(code) + '\n```',
  quote: (inner) => inner.split('\n').map((line) => '> ' + line).join('\n'),
  bullet: '• ',
  mention: (person) => `<@${person.id}>`,
};

/** Discord and Feishu card markdown: near-native, so constructs are re-emitted (headings and tables aside). */
export const PLAIN_MARKDOWN: MarkdownFormat = {
  escape: (text) => text,
  bold: (inner) => `**${inner}**`,
  italic: (inner) => `*${inner}*`,
  strike: (inner) => `~~${inner}~~`,
  code: (raw) => '`' + raw + '`',
  link: (label, url) => `[${label}](${url})`,
  fence: (code, lang) => '```' + lang + '\n' + code + '\n```',
  quote: (inner) => inner.split('\n').map((line) => '> ' + line).join('\n'),
  bullet: '- ',
};

export const DISCORD_MARKDOWN: MarkdownFormat = { ...PLAIN_MARKDOWN, mention: (person) => `<@${person.id}>` };

/** A card's lark_md at-tag. */
export const FEISHU_MARKDOWN: MarkdownFormat = { ...PLAIN_MARKDOWN, mention: (person) => `<at id=${person.id}></at>` };

// --- chunking ----------------------------------------------------------------

/**
 * Split markdown into pieces of at most `limit` UTF-16 units, at line boundaries (a longer line is cut, never inside a
 * surrogate pair). A code fence cut in two is closed in the first piece and reopened in the next.
 */
export function chunkMarkdown(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  let fresh = true; // nothing but a reopened fence line so far
  let fence: string | undefined;
  const flush = (): void => {
    chunks.push(current.join('\n') + (fence === undefined ? '' : '\n```'));
    current = fence === undefined ? [] : ['```' + fence];
    size = fence === undefined ? 0 : fence.length + 4;
    fresh = true;
  };
  const push = (line: string): void => {
    // Room for the closing fence that a split inside code adds.
    if (!fresh && size + line.length + 1 > limit - (fence === undefined ? 0 : 4)) flush();
    current.push(line);
    size += line.length + 1;
    fresh = false;
  };
  for (const line of text.split('\n')) {
    let rest = line;
    const budget = limit - 16;
    while (rest.length > budget) {
      let end = budget;
      const code = rest.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      push(rest.slice(0, end));
      rest = rest.slice(end);
    }
    push(rest);
    const opened = FENCE.exec(line);
    if (opened !== null) fence = fence === undefined ? (opened[1] ?? '') : undefined;
  }
  if (!fresh) chunks.push(current.join('\n'));
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

/**
 * Gmail on the Gmail API v1: search, read a message or a whole conversation, list labels (`gmail.readonly`), write,
 * list and send drafts and send mail (`gmail.compose`, which Google lists for drafts.send and messages.send), and
 * label messages and threads (`gmail.modify`). All three scopes are Google "restricted" scopes (BACKEND 10.18.2). The tool set
 * and wording follow github.com/taylorwilsdon/google_workspace_mcp (MIT); list_drafts and the four label tools carry the names and
 * arguments of Google's Gmail MCP server (https://developers.google.com/workspace/gmail/api/reference/mcp). That server has
 * no send tool, so send_message and send_draft are ours; sending is a destructive write and always asks.
 */
import { clip, itemsOf, nextPage, page, PAGE, str, type Api, type Args, type HostedTool } from './shared.js';

const G = 'https://www.googleapis.com/auth/';
export const GMAIL_SCOPES = [G + 'gmail.readonly', G + 'gmail.compose', G + 'gmail.modify'];
const BODY_LIMIT = 20_000;
const HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date'];

type Part = { mimeType?: string; filename?: string; body?: { data?: string; size?: number }; parts?: Part[]; headers?: { name: string; value: string }[] };

const decode = (data: string | undefined): string => (data === undefined ? '' : Buffer.from(data, 'base64url').toString('utf8'));

/** Plain text when the message has it, else its HTML with the tags taken out. */
function bodyText(part: Part): string {
  const all: Part[] = [];
  const walk = (node: Part) => {
    all.push(node);
    for (const child of node.parts ?? []) walk(child);
  };
  walk(part);
  const plain = all.find((node) => node.mimeType === 'text/plain' && node.filename === '' && node.body?.data !== undefined);
  if (plain !== undefined) return decode(plain.body?.data);
  const html = all.find((node) => node.mimeType === 'text/html' && node.body?.data !== undefined);
  if (html === undefined) return decode(part.body?.data);
  return decode(html.body?.data).replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
}

function headersOf(payload: Part | undefined): Record<string, string> {
  const found: Record<string, string> = {};
  for (const header of payload?.headers ?? []) if (HEADERS.includes(header.name)) found[header.name.toLowerCase()] = header.value;
  return found;
}

const threadUrl = (threadId: unknown) => (typeof threadId === 'string' ? 'https://mail.google.com/mail/u/0/#all/' + threadId : undefined);

function messageOf(message: Record<string, unknown>, withBody: boolean) {
  const payload = message.payload as Part | undefined;
  const attachments: string[] = [];
  const walk = (node: Part | undefined) => {
    if (node === undefined) return;
    if (node.filename !== undefined && node.filename !== '') attachments.push(node.filename);
    for (const child of node.parts ?? []) walk(child);
  };
  walk(payload);
  return {
    id: message.id,
    threadId: message.threadId,
    ...headersOf(payload),
    snippet: message.snippet,
    labels: message.labelIds,
    url: threadUrl(message.threadId),
    ...(withBody && payload !== undefined ? { body: clip(bodyText(payload), BODY_LIMIT) } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

async function messageHeaders(api: Api, id: string) {
  // One metadata read per result; the Gmail list call returns ids only.
  const message = await api('/users/me/messages/' + encodeURIComponent(id), { format: 'metadata' });
  return messageOf(message, false);
}

/** RFC 2822 message for a draft; non-ASCII subjects are encoded (RFC 2047). */
function rawMessage(args: Args): string {
  const subject = str(args.subject) ?? '';
  const encodedSubject = /^[\x20-\x7e]*$/.test(subject) ? subject : '=?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=';
  const lines = [
    'To: ' + (str(args.to) ?? ''),
    ...(str(args.cc) === undefined ? [] : ['Cc: ' + str(args.cc)]),
    ...(str(args.bcc) === undefined ? [] : ['Bcc: ' + str(args.bcc)]),
    'Subject: ' + encodedSubject,
    ...(str(args.inReplyTo) === undefined ? [] : ['In-Reply-To: ' + str(args.inReplyTo), 'References: ' + str(args.inReplyTo)]),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(str(args.body) ?? '').toString('base64'),
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

export const GMAIL_TOOLS: HostedTool[] = [
  {
    name: 'search_messages',
    title: 'Search email',
    description: 'Search the mailbox with Gmail search operators (from:, to:, subject:, is:unread, has:attachment, after:2026/10/01, label:, …). Returns sender, subject, date and snippet per message.',
    properties: { query: { type: 'string', description: 'Gmail search query; empty lists the newest messages.' }, ...PAGE },
    run: async (api, args) => {
      const body = await api('/users/me/messages', { q: str(args.query), ...page(args) });
      const messages = await Promise.all(itemsOf(body, 'messages').map((item) => messageHeaders(api, String(item.id))));
      return { messages, ...nextPage(body) };
    },
  },
  {
    name: 'get_message',
    title: 'Read an email',
    description: 'Read one message: headers, text body and attachment names.',
    properties: { messageId: { type: 'string', description: 'Message id from search_messages.' } },
    required: ['messageId'],
    run: async (api, args) => messageOf(await api('/users/me/messages/' + encodeURIComponent(str(args.messageId) ?? ''), { format: 'full' }), true),
  },
  {
    name: 'get_thread',
    title: 'Read a conversation',
    description: 'Read a whole conversation, oldest message first.',
    properties: { threadId: { type: 'string', description: 'Thread id from search_messages.' } },
    required: ['threadId'],
    run: async (api, args) => {
      const thread = await api('/users/me/threads/' + encodeURIComponent(str(args.threadId) ?? ''), { format: 'full' });
      return { id: thread.id, url: threadUrl(thread.id), messages: itemsOf(thread, 'messages').map((message) => messageOf(message, true)) };
    },
  },
  {
    name: 'list_labels',
    title: 'List labels',
    description: "List the mailbox's labels (system and the owner's own), for label: searches.",
    properties: {},
    run: async (api) => ({ labels: itemsOf(await api('/users/me/labels'), 'labels').map((label) => ({ id: label.id, name: label.name, type: label.type })) }),
  },
  {
    name: 'create_draft',
    title: 'Write a draft',
    description: 'Write a plain-text draft in Gmail for the owner to review and send. It is not sent.',
    properties: {
      to: { type: 'string', description: 'Recipients, comma-separated.' },
      subject: { type: 'string', description: 'Subject line.' },
      body: { type: 'string', description: 'Plain-text body.' },
      cc: { type: 'string', description: 'Cc recipients, comma-separated.' },
      bcc: { type: 'string', description: 'Bcc recipients, comma-separated.' },
      threadId: { type: 'string', description: 'Put the draft in this conversation (a reply).' },
      inReplyTo: { type: 'string', description: 'Message-ID header of the message being answered, with threadId.' },
    },
    required: ['to', 'subject', 'body'],
    writes: true,
    run: async (api, args) => {
      const draft = await api('/users/me/drafts', {}, { method: 'POST', body: { message: { raw: rawMessage(args), ...(str(args.threadId) === undefined ? {} : { threadId: str(args.threadId) }) } } });
      const message = (draft.message ?? {}) as Record<string, unknown>;
      return { draftId: draft.id, messageId: message.id, threadId: message.threadId, url: 'https://mail.google.com/mail/u/0/#drafts' };
    },
  },
  {
    name: 'list_drafts',
    title: 'List drafts',
    description: 'List the drafts in the mailbox, newest first, with recipients, subject and text.',
    properties: {
      query: { type: 'string', description: 'Gmail search query, e.g. to:ada@example.com.' },
      pageSize: { type: 'integer', minimum: 1, maximum: 50, description: 'How many drafts (default 20).' },
      pageToken: PAGE.pageToken,
      view: { type: 'string', enum: ['DRAFT_VIEW_UNSPECIFIED', 'DRAFT_VIEW_METADATA_ONLY', 'DRAFT_VIEW_FULL'], description: 'METADATA_ONLY leaves out the text (default FULL).' },
    },
    run: async (api, args) => {
      const body = await api('/users/me/drafts', { q: str(args.query), ...page({ maxResults: args.pageSize ?? 20, pageToken: args.pageToken }) });
      const metadataOnly = args.view === 'DRAFT_VIEW_METADATA_ONLY';
      const drafts = await Promise.all(itemsOf(body, 'drafts').map(async (draft) => {
        const id = String((draft.message as Record<string, unknown> | undefined)?.id);
        const message = await api('/users/me/messages/' + encodeURIComponent(id), { format: metadataOnly ? 'metadata' : 'full' });
        const shown = messageOf(message, !metadataOnly);
        return { draftId: draft.id, ...(metadataOnly ? { ...shown, subject: undefined } : shown) };
      }));
      return { drafts, ...nextPage(body) };
    },
  },
  {
    name: 'send_message',
    title: 'Send an email',
    description: 'Send a plain-text email now, a new message or a reply in a conversation (give threadId). This cannot be undone; use only for text the owner has approved.',
    properties: {
      to: { type: 'string', description: 'Recipients, comma-separated.' },
      subject: { type: 'string', description: 'Subject line (a reply defaults to "Re: " and the conversation subject).' },
      body: { type: 'string', description: 'Plain-text body.' },
      cc: { type: 'string', description: 'Cc recipients, comma-separated.' },
      bcc: { type: 'string', description: 'Bcc recipients, comma-separated.' },
      threadId: { type: 'string', description: 'Reply in this conversation: the message is threaded under its last message.' },
    },
    required: ['to', 'body'],
    writes: true,
    destructive: true,
    run: async (api, args) => {
      const threadId = str(args.threadId);
      let fields: Args = args;
      if (threadId !== undefined) {
        const thread = await api('/users/me/threads/' + encodeURIComponent(threadId), { format: 'metadata' });
        const last = itemsOf(thread, 'messages').at(-1);
        const header = (name: string) => ((last?.payload as Part | undefined)?.headers ?? []).find((entry) => entry.name.toLowerCase() === name)?.value;
        const subject = header('subject') ?? '';
        fields = { ...args, subject: str(args.subject) ?? (/^re:/i.test(subject) ? subject : 'Re: ' + subject), inReplyTo: header('message-id') };
      }
      const sent = await api('/users/me/messages/send', {}, { method: 'POST', body: { raw: rawMessage(fields), ...(threadId === undefined ? {} : { threadId }) } });
      return { messageId: sent.id, threadId: sent.threadId, url: threadUrl(sent.threadId) };
    },
  },
  {
    name: 'send_draft',
    title: 'Send a draft',
    description: 'Send an existing draft now. This cannot be undone; use only for a draft the owner has approved.',
    properties: { draftId: { type: 'string', description: 'Draft id from create_draft or list_drafts.' } },
    required: ['draftId'],
    writes: true,
    destructive: true,
    run: async (api, args) => {
      const sent = await api('/users/me/drafts/send', {}, { method: 'POST', body: { id: str(args.draftId) } });
      return { messageId: sent.id, threadId: sent.threadId, url: threadUrl(sent.threadId) };
    },
  },
  ...labelTools('message'),
  ...labelTools('thread'),
];

/** label_message / unlabel_message (or the _thread pair): add or remove labels by id (system ids such as INBOX, STARRED, UNREAD or ids from list_labels). */
function labelTools(kind: 'message' | 'thread'): HostedTool[] {
  const idName = kind + 'Id';
  const path = (id: string) => '/users/me/' + kind + 's/' + encodeURIComponent(id) + '/modify';
  const make = (verb: 'label' | 'unlabel'): HostedTool => ({
    name: verb + '_' + kind,
    title: (verb === 'label' ? 'Label a ' : 'Unlabel a ') + (kind === 'message' ? 'message' : 'conversation'),
    description: (verb === 'label' ? 'Add labels to' : 'Remove labels from') + ' a ' + kind + ' (label ids, not names; list_labels gives them). Unlabeling INBOX archives; UNREAD marks it read.',
    properties: { [idName]: { type: 'string', description: 'The ' + kind + ' id.' }, labelIds: { type: 'array', items: { type: 'string' }, description: 'Label ids, e.g. INBOX, STARRED, UNREAD, IMPORTANT or ids from list_labels.' } },
    required: [idName, 'labelIds'],
    writes: true,
    run: async (api, args) => {
      const labelIds = Array.isArray(args.labelIds) ? args.labelIds.filter((id): id is string => typeof id === 'string') : [];
      const done = await api(path(str(args[idName]) ?? ''), {}, { method: 'POST', body: verb === 'label' ? { addLabelIds: labelIds } : { removeLabelIds: labelIds } });
      return { id: done.id, labels: done.labelIds };
    },
  });
  return [make('label'), make('unlabel')];
}

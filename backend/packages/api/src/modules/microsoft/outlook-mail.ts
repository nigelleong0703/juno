/**
 * Outlook mail on Microsoft Graph (`/me/messages`): search, read a message or conversation, list folders, write a
 * draft (`Mail.ReadWrite`; a draft is never sent by creating it) and send a draft (`Mail.Send`). Text output.
 */
import { str, type Args, type HostedTool } from '../google/shared.js';
import { bodyText, escapeOData, listPage, MS_PAGE, MS_ZONE, none, people, person, rows, size, when, zoneOf } from './shared.js';

export const OUTLOOK_MAIL_SCOPES = ['Mail.ReadWrite', 'Mail.Send', 'offline_access'];
const BODY_LIMIT = 20_000;
const LIST_FIELDS = 'id,conversationId,subject,from,receivedDateTime,bodyPreview,hasAttachments,isRead,isDraft';
const FULL_FIELDS = LIST_FIELDS + ',toRecipients,ccRecipients,webLink,body';

const line = (message: Record<string, unknown>, zone: string | undefined): string =>
  [
    [
    '[' + String(message.id) + ']',
    when(message.receivedDateTime, zone),
    person(message.from) || '(no sender)',
    '|',
    String(message.subject ?? '(no subject)'),
    message.isRead === false ? '(unread)' : '',
    message.isDraft === true ? '(draft)' : '',
    message.hasAttachments === true ? '(attachments)' : '',
    ].filter((part) => part !== '').join(' '),
    '    conversation ' + String(message.conversationId) + ': ' + String(message.bodyPreview ?? '').replace(/\s+/g, ' ').slice(0, 160),
  ].join('\n');

async function fullMessage(message: Record<string, unknown>, zone: string | undefined): Promise<string> {
  const attachments = Array.isArray(message.attachments) ? (message.attachments as Record<string, unknown>[]).map((item) => String(item.name)) : [];
  return [
    'Message ' + String(message.id) + (message.isDraft === true ? ' (draft)' : ''),
    'From: ' + person(message.from),
    'To: ' + people(message.toRecipients),
    ...(people(message.ccRecipients) === '' ? [] : ['Cc: ' + people(message.ccRecipients)]),
    'Date: ' + when(message.receivedDateTime, zone),
    'Subject: ' + String(message.subject ?? ''),
    ...(attachments.length > 0 ? ['Attachments: ' + attachments.join(', ')] : []),
    ...(typeof message.webLink === 'string' ? ['Link: ' + message.webLink] : []),
    '',
    bodyText(message.body, BODY_LIMIT),
  ].join('\n');
}

const recipients = (value: string | undefined) => (value ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '').map((address) => ({ emailAddress: { address } }));

export const OUTLOOK_MAIL_TOOLS: HostedTool[] = [
  {
    name: 'search_messages',
    title: 'Search email',
    description: 'Search the mailbox by words (sender, subject, body; also from:, subject:, hasattachments:true), or list the newest messages when the query is empty. Optionally within one folder.',
    properties: { query: { type: 'string', description: 'Search words; empty lists the newest messages.' }, folderId: { type: 'string', description: 'Folder id from list_folders (default: all mail).' }, ...MS_PAGE, ...MS_ZONE },
    run: async (api, args) => {
      const folder = str(args.folderId);
      const query = str(args.query);
      const path = (folder === undefined ? '/me' : '/me/mailFolders/' + encodeURIComponent(folder)) + '/messages';
      // $search cannot be combined with $orderby (Graph ranks by relevance then).
      const { items, more } = await listPage(api, args, path, { $top: size(args), $select: LIST_FIELDS, ...(query === undefined ? { $orderby: 'receivedDateTime desc' } : { $search: '"' + query.replace(/"/g, '') + '"' }) });
      const zone = zoneOf(args);
      return items.length === 0 ? none('messages found') : items.map((message) => line(message, zone)).join('\n') + more;
    },
  },
  {
    name: 'get_message',
    title: 'Read an email',
    description: 'Read one message: headers, text body and attachment names.',
    properties: { messageId: { type: 'string', description: 'Message id from search_messages.' }, ...MS_ZONE },
    required: ['messageId'],
    run: async (api, args) =>
      fullMessage(await api('/me/messages/' + encodeURIComponent(str(args.messageId) ?? ''), { $select: FULL_FIELDS, $expand: 'attachments($select=name)' }), zoneOf(args)),
  },
  {
    name: 'get_thread',
    title: 'Read a conversation',
    description: 'Read a whole conversation, oldest message first (up to 50 messages).',
    properties: { conversationId: { type: 'string', description: 'conversation id shown by search_messages.' }, ...MS_ZONE },
    required: ['conversationId'],
    run: async (api, args) => {
      const body = await api('/me/messages', { $filter: "conversationId eq '" + escapeOData(str(args.conversationId) ?? '') + "'", $top: '50', $select: FULL_FIELDS });
      const zone = zoneOf(args);
      const messages = rows(body).sort((a, b) => String(a.receivedDateTime).localeCompare(String(b.receivedDateTime)));
      return messages.length === 0 ? none('messages in that conversation') : (await Promise.all(messages.map((message) => fullMessage(message, zone)))).join('\n\n----\n\n');
    },
  },
  {
    name: 'list_folders',
    title: 'List mail folders',
    description: 'List the mail folders (Inbox, Sent, Drafts and the owner\'s own) with their ids and counts, for search_messages.',
    properties: {},
    run: async (api) => {
      const folders = rows(await api('/me/mailFolders', { $top: '100', $select: 'id,displayName,unreadItemCount,totalItemCount' }));
      return folders.length === 0 ? none('folders') : folders.map((folder) => '[' + String(folder.id) + '] ' + String(folder.displayName) + ' (' + String(folder.unreadItemCount) + ' unread of ' + String(folder.totalItemCount) + ')').join('\n');
    },
  },
  {
    name: 'create_draft',
    title: 'Write a draft',
    description: 'Write a plain-text draft in Outlook for the owner to review. It is not sent; send_draft does that.',
    properties: {
      to: { type: 'string', description: 'Recipients, comma-separated addresses.' },
      subject: { type: 'string', description: 'Subject line.' },
      body: { type: 'string', description: 'Plain-text body.' },
      cc: { type: 'string', description: 'Cc recipients, comma-separated.' },
      bcc: { type: 'string', description: 'Bcc recipients, comma-separated.' },
      replyToMessageId: { type: 'string', description: 'Make it a reply to this message id; body is then put above the quoted message and to/subject are taken from it.' },
    },
    required: ['body'],
    writes: true,
    run: async (api, args: Args) => {
      const content = str(args.body) ?? '';
      const replyTo = str(args.replyToMessageId);
      const draft = replyTo === undefined
        ? await api('/me/messages', {}, { method: 'POST', body: { subject: str(args.subject) ?? '', body: { contentType: 'Text', content }, toRecipients: recipients(str(args.to)), ccRecipients: recipients(str(args.cc)), bccRecipients: recipients(str(args.bcc)) } })
        : await api('/me/messages/' + encodeURIComponent(replyTo) + '/createReply', {}, { method: 'POST', body: { comment: content } });
      return 'Draft saved (not sent). Draft id: ' + String(draft.id) + (typeof draft.webLink === 'string' ? '\nOpen it: ' + draft.webLink : '');
    },
  },
  {
    name: 'send_draft',
    title: 'Send a draft',
    description: 'Send an existing draft now. This cannot be undone; use only for a draft the owner has approved.',
    properties: { draftId: { type: 'string', description: 'Draft id from create_draft or search_messages.' } },
    required: ['draftId'],
    writes: true,
    destructive: true,
    run: async (api, args) => {
      await api('/me/messages/' + encodeURIComponent(str(args.draftId) ?? '') + '/send', {}, { method: 'POST', body: {} });
      return 'Sent.';
    },
  },
  // Graph's reply, replyAll and forward send at once (Mail.Send); the quoted original is added by Outlook.
  ...[
    { name: 'reply_to_message', action: 'reply', title: 'Reply to an email', description: 'Reply to the sender of a message now, with the original quoted below. This cannot be undone; use only for text the owner has approved.' },
    { name: 'reply_all', action: 'replyAll', title: 'Reply to everyone', description: 'Reply to the sender and everyone else on a message now, with the original quoted below. This cannot be undone; use only for text the owner has approved.' },
  ].map(({ name, action, title, description }): HostedTool => ({
    name, title, description,
    properties: { messageId: { type: 'string', description: 'Message id from search_messages.' }, body: { type: 'string', description: 'Plain-text reply, put above the quoted message.' } },
    required: ['messageId', 'body'],
    writes: true,
    destructive: true,
    run: async (api, args) => {
      await api('/me/messages/' + encodeURIComponent(str(args.messageId) ?? '') + '/' + action, {}, { method: 'POST', body: { comment: str(args.body) ?? '' } });
      return 'Sent.';
    },
  })),
  {
    name: 'forward_message',
    title: 'Forward an email',
    description: 'Forward a message to other people now, with an optional note above it. This cannot be undone; use only for recipients and text the owner has approved.',
    properties: { messageId: { type: 'string', description: 'Message id from search_messages.' }, to: { type: 'string', description: 'Recipients, comma-separated addresses.' }, body: { type: 'string', description: 'Plain-text note put above the forwarded message.' } },
    required: ['messageId', 'to'],
    writes: true,
    destructive: true,
    run: async (api, args) => {
      await api('/me/messages/' + encodeURIComponent(str(args.messageId) ?? '') + '/forward', {}, { method: 'POST', body: { comment: str(args.body) ?? '', toRecipients: recipients(str(args.to)) } });
      return 'Forwarded.';
    },
  },
  {
    name: 'move_message',
    title: 'Move an email',
    description: 'Move a message to another folder (Archive, Deleted Items, or the owner\'s own); the message gets a new id, shown in the answer.',
    properties: { messageId: { type: 'string', description: 'Message id from search_messages.' }, folderId: { type: 'string', description: 'Destination folder id from list_folders, or a well-known name such as archive, deleteditems, inbox, junkemail.' } },
    required: ['messageId', 'folderId'],
    writes: true,
    run: async (api, args) => {
      const moved = await api('/me/messages/' + encodeURIComponent(str(args.messageId) ?? '') + '/move', {}, { method: 'POST', body: { destinationId: str(args.folderId) } });
      return 'Moved. New message id: ' + String(moved.id);
    },
  },
  {
    name: 'flag_message',
    title: 'Flag an email',
    description: 'Flag a message for follow-up, mark the flag complete, or clear it.',
    properties: { messageId: { type: 'string', description: 'Message id from search_messages.' }, status: { type: 'string', enum: ['flagged', 'complete', 'notFlagged'], description: 'The new flag (default flagged).' } },
    required: ['messageId'],
    writes: true,
    run: async (api, args) => {
      const status = str(args.status) ?? 'flagged';
      await api('/me/messages/' + encodeURIComponent(str(args.messageId) ?? ''), {}, { method: 'PATCH', body: { flag: { flagStatus: status } } });
      return 'Flag set to ' + status + '.';
    },
  },
];

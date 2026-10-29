/**
 * File bytes in and out per platform (the `attachment` and `sendFile` abilities) and the files a parser reads off an inbound message,
 * against a fake transport: the URL, method, credentials and body each call makes (per the platforms' docs), and what comes back.
 * No live network.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from '@agent-desktop/public-contracts';
import { discordAbilities } from '../discord/abilities.js';
import { parseDiscordMessage } from '../discord/api.js';
import { feishuAbilities } from '../feishu/abilities.js';
import { clearFeishuTokenCache, parseFeishuMessage } from '../feishu/api.js';
import { slackAbilities, slackChannelExternal } from '../slack/abilities.js';
import { parseSlackEvent, slackFiles } from '../slack/api.js';
import { telegramAbilities } from '../telegram/abilities.js';
import { parseTelegramUpdate } from '../telegram/api.js';
import type { LocalFile } from '../abilities.js';

interface Hit { url: string; method: string; headers: Headers; body: unknown }

/** Records each call and answers with `reply(hit)`. Bodies: FormData and URLSearchParams as they are, JSON parsed, bytes as they are. */
function route(reply: (hit: Hit) => Response): { fetchFn: typeof fetch; hits: Hit[] } {
  const hits: Hit[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const raw = init?.body;
    const body = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw ?? null;
    const hit: Hit = { url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body };
    hits.push(hit);
    return reply(hit);
  };
  return { fetchFn, hits };
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status });
const BYTES = new TextEncoder().encode('hello file');
const FILE: LocalFile = { name: 'notes.txt', mime: 'text/plain', bytes: BYTES };

beforeEach(() => clearFeishuTokenCache());

describe('Telegram files', () => {
  const auth = { token: 'tok' };

  it('reads a file: getFile for the path, then the file host with the token in the path', async () => {
    const { fetchFn, hits } = route((hit) => hit.url.includes('/file/bot')
      ? new Response(BYTES, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      : json({ ok: true, result: { file_id: 'F1', file_path: 'documents/notes.txt' } }));
    const got = await telegramAbilities.attachment(fetchFn, auth, { messageId: '1:5', fileId: 'F1' });
    expect(got).toEqual({ status: 'ok', value: { bytes: BYTES, mime: 'text/plain' } });
    expect(hits.map((hit) => [hit.method, hit.url, hit.body])).toEqual([
      ['POST', 'https://api.telegram.org/bottok/getFile', { file_id: 'F1' }],
      ['GET', 'https://api.telegram.org/file/bottok/documents/notes.txt', null],
    ]);
  });

  it('says why a file cannot be given and does not download it', async () => {
    const { fetchFn, hits } = route(() => json({ ok: false, description: 'Bad Request: file is too big' }, 400));
    expect(await telegramAbilities.attachment(fetchFn, auth, { messageId: '1:5', fileId: 'F9' })).toEqual({ status: 'failed', error: 'Telegram would not give this file: Bad Request: file is too big' });
    expect(hits).toHaveLength(1);
  });

  it('sends a file with sendDocument as multipart: the chat, the topic of the thread, the caption and the bytes', async () => {
    const { fetchFn, hits } = route(() => json({ ok: true, result: { message_id: 77 } }));
    const sent = await telegramAbilities.sendFile(fetchFn, auth, { chatId: 'C1', threadId: 'C1:42' }, FILE, 'here');
    expect(sent).toEqual({ status: 'ok', value: { messageId: '77' } });
    const hit = hits[0];
    expect(hit?.url).toBe('https://api.telegram.org/bottok/sendDocument');
    const form = hit?.body as FormData;
    expect(form.get('chat_id')).toBe('C1');
    expect(form.get('message_thread_id')).toBe('42');
    expect(form.get('caption')).toBe('here');
    const document = form.get('document') as File;
    expect(document.name).toBe('notes.txt');
    expect(document.type).toBe('text/plain');
    expect(new Uint8Array(await document.arrayBuffer())).toEqual(BYTES);
  });

  it('refuses a file over the upload cap before any call', async () => {
    const { fetchFn, hits } = route(() => json({ ok: true }));
    const big: LocalFile = { name: 'big.bin', mime: 'application/octet-stream', bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1) };
    expect(await telegramAbilities.sendFile(fetchFn, auth, { chatId: 'C1', threadId: 'C1' }, big)).toMatchObject({ status: 'failed' });
    expect(hits).toHaveLength(0);
  });

  it('parses a document with its caption (the mention in the caption is the bot\'s) and a photo without text', () => {
    const doc = parseTelegramUpdate({
      update_id: 1,
      message: {
        message_id: 5, from: { id: 9, first_name: 'Amy' }, chat: { id: -100, type: 'supergroup', title: 'Team' },
        caption: '@juno_bot read this', caption_entities: [{ type: 'mention', offset: 0, length: 9 }],
        document: { file_id: 'F1', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 1234 },
      },
    }, 'juno_bot');
    expect(doc).toMatchObject({ text: 'read this', files: [{ fileId: 'F1', name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 1234 }] });
    const photo = parseTelegramUpdate({
      update_id: 2,
      message: { message_id: 6, from: { id: 9, first_name: 'Amy' }, chat: { id: 9, type: 'private' }, photo: [{ file_id: 'P1', file_size: 10 }, { file_id: 'P2', file_size: 900 }] },
    }, 'juno_bot');
    expect(photo).toMatchObject({ text: '', files: [{ fileId: 'P2', name: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 900 }] });
    // A file in a group that does not address the bot is not the agent's business.
    expect(parseTelegramUpdate({ update_id: 3, message: { message_id: 7, from: { id: 9, first_name: 'Amy' }, chat: { id: -100, type: 'group' }, document: { file_id: 'F2' } } }, 'juno_bot')).toBeNull();
  });
});

describe('Slack files', () => {
  const auth = { token: 'xoxb' };

  it('reads a file from files.slack.com with the bot token', async () => {
    const { fetchFn, hits } = route(() => new Response(BYTES, { status: 200, headers: { 'content-type': 'text/plain' } }));
    const url = 'https://files.slack.com/files-pri/T1-F1/notes.txt';
    expect(await slackAbilities.attachment(fetchFn, auth, { messageId: 'C1:1.2', fileId: url })).toEqual({ status: 'ok', value: { bytes: BYTES, mime: 'text/plain' } });
    expect(hits.map((hit) => [hit.url, hit.headers.get('authorization')])).toEqual([[url, 'Bearer xoxb']]);
  });

  it('never sends the token to another host', async () => {
    const { fetchFn, hits } = route(() => new Response(BYTES));
    expect(await slackAbilities.attachment(fetchFn, auth, { messageId: 'C1:1.2', fileId: 'https://evil.example/steal' })).toMatchObject({ status: 'failed' });
    expect(hits).toHaveLength(0);
  });

  it('sends a file in three steps: the upload URL, the bytes, then the share into the thread', async () => {
    const { fetchFn, hits } = route((hit) => {
      if (hit.url.endsWith('/files.getUploadURLExternal')) return json({ ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F77' });
      if (hit.url.startsWith('https://files.slack.com/upload')) return new Response('OK', { status: 200 });
      return json({ ok: true, files: [{ id: 'F77', title: 'notes.txt' }] });
    });
    const sent = await slackAbilities.sendFile(fetchFn, auth, { chatId: 'C1', threadId: 'C1:1700.0001' }, FILE, 'here');
    expect(sent).toEqual({ status: 'ok', value: {} });
    expect(hits.map((hit) => [hit.method, hit.url])).toEqual([
      ['POST', 'https://slack.com/api/files.getUploadURLExternal'],
      ['POST', 'https://files.slack.com/upload/v1/abc'],
      ['POST', 'https://slack.com/api/files.completeUploadExternal'],
    ]);
    const ticket = hits[0]?.body as URLSearchParams;
    expect([ticket.get('filename'), ticket.get('length')]).toEqual(['notes.txt', String(BYTES.length)]);
    expect(hits[1]?.body).toEqual(BYTES);
    expect(hits[1]?.headers.get('authorization')).toBeNull();
    expect(hits[2]?.body).toEqual({ files: [{ id: 'F77', title: 'notes.txt' }], channel_id: 'C1', thread_ts: '1700.0001', initial_comment: 'here' });
    expect(hits[2]?.headers.get('authorization')).toBe('Bearer xoxb');
  });

  it('stops when the upload URL is not given', async () => {
    const { fetchFn, hits } = route(() => json({ ok: false, error: 'missing_scope' }));
    expect(await slackAbilities.sendFile(fetchFn, auth, { chatId: 'C1', threadId: 'C1' }, FILE)).toEqual({ status: 'failed', error: 'Slack upload failed: missing_scope' });
    expect(hits).toHaveLength(1);
  });

  it('reads the files of a file_share message, which may have no text', () => {
    const event = parseSlackEvent({
      event_id: 'Ev1', type: 'event_callback',
      event: { type: 'message', subtype: 'file_share', channel: 'C1', channel_type: 'im', user: 'U9', ts: '1.2', text: '',
        files: [{ id: 'F1', name: 'a.png', mimetype: 'image/png', size: 9, url_private: 'https://files.slack.com/a.png' }, { id: 'F2', name: null, url_private: undefined }] },
    }, 'BOT');
    expect(event).toMatchObject({ chatType: 'private', text: '', externalMessageId: 'C1:1.2', files: [{ fileId: 'https://files.slack.com/a.png', name: 'a.png', mimeType: 'image/png', sizeBytes: 9 }] });
    expect(slackFiles([{ id: 'F3', url_private: 'https://files.slack.com/x' }])).toEqual([{ fileId: 'https://files.slack.com/x', name: 'F3' }]);
  });

  it('tells a Slack Connect channel (is_ext_shared) from an internal one; missing_scope is "not external" and cached; any other failure is external and not cached', async () => {
    const shared = route(() => json({ ok: true, channel: { id: 'CX1', is_ext_shared: true } }));
    expect(await slackChannelExternal(shared.fetchFn, 'xoxb', 'CX1')).toEqual({ external: true, missingScope: false });
    expect(await slackChannelExternal(shared.fetchFn, 'xoxb', 'CX1')).toEqual({ external: true, missingScope: false });
    expect(shared.hits).toHaveLength(1);
    const internal = route(() => json({ ok: true, channel: { id: 'CX2', is_ext_shared: false } }));
    expect(await slackChannelExternal(internal.fetchFn, 'xoxb', 'CX2')).toEqual({ external: false, missingScope: false });
    // Without channels:read / groups:read the answer is "not external" (so the groups are not all quiet), cached so it is asked once.
    const denied = route(() => json({ ok: false, error: 'missing_scope' }));
    expect(await slackChannelExternal(denied.fetchFn, 'xoxb', 'CX3')).toEqual({ external: false, missingScope: true });
    expect(await slackChannelExternal(denied.fetchFn, 'xoxb', 'CX3')).toEqual({ external: false, missingScope: true });
    expect(denied.hits).toHaveLength(1);
    // A rate limit is not a missing scope: the group stays quiet and the next message asks again.
    const limited = route(() => json({ ok: false, error: 'ratelimited' }));
    expect(await slackChannelExternal(limited.fetchFn, 'xoxb', 'CX4')).toEqual({ external: true, missingScope: false });
    expect(await slackChannelExternal(limited.fetchFn, 'xoxb', 'CX4')).toEqual({ external: true, missingScope: false });
    expect(limited.hits).toHaveLength(2);
  });
});

describe('Discord files', () => {
  const auth = { token: 'bot-token' };
  const CDN = 'https://cdn.discordapp.com/attachments/1/2/log.txt';

  it('reads an attachment from the CDN without credentials, and only from the CDN', async () => {
    const { fetchFn, hits } = route(() => new Response(BYTES, { headers: { 'content-type': 'text/plain' } }));
    expect(await discordAbilities.attachment(fetchFn, auth, { messageId: 'M1', fileId: CDN })).toEqual({ status: 'ok', value: { bytes: BYTES, mime: 'text/plain' } });
    expect(hits[0]?.headers.get('authorization')).toBeNull();
    expect(await discordAbilities.attachment(fetchFn, auth, { messageId: 'M1', fileId: 'https://evil.example/x' })).toMatchObject({ status: 'failed' });
    expect(hits).toHaveLength(1);
  });

  it('posts a file as a multipart message: the caption as payload_json, the bytes as files[0]', async () => {
    const { fetchFn, hits } = route(() => json({ id: 'M9' }));
    expect(await discordAbilities.sendFile(fetchFn, auth, { chatId: 'C1', threadId: 'C1' }, FILE, 'here')).toEqual({ status: 'ok', value: { messageId: 'M9' } });
    const hit = hits[0];
    expect([hit?.method, hit?.url, hit?.headers.get('authorization')]).toEqual(['POST', 'https://discord.com/api/v10/channels/C1/messages', 'Bot bot-token']);
    const form = hit?.body as FormData;
    expect(JSON.parse(String(form.get('payload_json')))).toEqual({ content: 'here', attachments: [{ id: 0, filename: 'notes.txt' }] });
    expect((form.get('files[0]') as File).name).toBe('notes.txt');
  });

  it('reads the attachments of a mention, which may have no text', () => {
    const event = parseDiscordMessage({
      id: 'M5', channel_id: 'C1', guild_id: 'G1', content: '<@BOT>',
      author: { id: 'U9', username: 'amy' },
      mentions: [{ id: 'BOT', username: 'juno' }],
      attachments: [{ id: 'A1', filename: 'log.txt', content_type: 'text/plain', size: 5, url: CDN }],
    }, 'BOT');
    expect(event).toMatchObject({ chatType: 'group', text: '', files: [{ fileId: CDN, name: 'log.txt', mimeType: 'text/plain', sizeBytes: 5 }] });
  });
});

describe('Feishu files', () => {
  const auth = { token: 'secret', appId: 'cli_1' };
  const tokenAnswer = (hit: Hit): Response | undefined => hit.url.endsWith('/tenant_access_token/internal') ? json({ code: 0, tenant_access_token: 't-1', expire: 7200 }) : undefined;

  it('reads a file of a message with the tenant token; an image key reads as an image', async () => {
    const { fetchFn, hits } = route((hit) => tokenAnswer(hit) ?? new Response(BYTES, { headers: { 'content-type': 'application/octet-stream' } }));
    expect(await feishuAbilities.attachment(fetchFn, auth, { messageId: 'om_1', fileId: 'file_abc' })).toEqual({ status: 'ok', value: { bytes: BYTES, mime: 'application/octet-stream' } });
    expect(await feishuAbilities.attachment(fetchFn, auth, { messageId: 'om_1', fileId: 'img_x' })).toMatchObject({ status: 'ok' });
    const resources = hits.filter((hit) => hit.url.includes('/resources/'));
    expect(resources.map((hit) => [hit.url, hit.headers.get('authorization')])).toEqual([
      ['https://open.feishu.cn/open-apis/im/v1/messages/om_1/resources/file_abc?type=file', 'Bearer t-1'],
      ['https://open.feishu.cn/open-apis/im/v1/messages/om_1/resources/img_x?type=image', 'Bearer t-1'],
    ]);
  });

  it('uploads a file (file_type stream) and sends a file message carrying the file_key into the chat', async () => {
    const { fetchFn, hits } = route((hit) => tokenAnswer(hit) ?? (hit.url.endsWith('/im/v1/files')
      ? json({ code: 0, data: { file_key: 'file_new' } })
      : json({ code: 0, data: { message_id: 'om_9' } })));
    expect(await feishuAbilities.sendFile(fetchFn, auth, { chatId: 'oc_1', threadId: 'oc_1' }, FILE)).toEqual({ status: 'ok', value: { messageId: 'om_9' } });
    const upload = hits.find((hit) => hit.url.endsWith('/im/v1/files'));
    const form = upload?.body as FormData;
    expect([form.get('file_type'), form.get('file_name')]).toEqual(['stream', 'notes.txt']);
    expect(upload?.headers.get('authorization')).toBe('Bearer t-1');
    const send = hits.find((hit) => hit.url.includes('/im/v1/messages?'));
    expect([send?.url, send?.body]).toEqual([
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      { receive_id: 'oc_1', msg_type: 'file', content: '{"file_key":"file_new"}' },
    ]);
  });

  it('replies in the thread when the thread names a root message', async () => {
    const { fetchFn, hits } = route((hit) => tokenAnswer(hit) ?? (hit.url.endsWith('/im/v1/files') ? json({ code: 0, data: { file_key: 'file_2' } }) : json({ code: 0, data: { message_id: 'om_10' } })));
    await feishuAbilities.sendFile(fetchFn, auth, { chatId: 'oc_1', threadId: 'oc_1:om_root' }, FILE);
    const reply = hits.find((hit) => hit.url.endsWith('/messages/om_root/reply'));
    expect(reply?.body).toEqual({ msg_type: 'file', content: '{"file_key":"file_2"}' });
  });

  it('parses a file and an image message (no text, no mention needed in a private chat)', () => {
    const file = parseFeishuMessage({
      sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' },
      message: { message_id: 'om_1', chat_id: 'oc_p', chat_type: 'p2p', message_type: 'file', content: '{"file_key":"file_k","file_name":"a.pdf"}' },
    }, 'ou_bot');
    expect(file).toMatchObject({ chatType: 'private', text: '', externalMessageId: 'om_1', files: [{ fileId: 'file_k', name: 'a.pdf' }] });
    const image = parseFeishuMessage({
      sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' },
      message: { message_id: 'om_2', chat_id: 'oc_p', chat_type: 'p2p', message_type: 'image', content: '{"image_key":"img_k"}' },
    }, 'ou_bot');
    expect(image).toMatchObject({ files: [{ fileId: 'img_k', name: 'image' }] });
    // A file in a group has no mention to address the bot with, so it is not heard.
    expect(parseFeishuMessage({
      sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' },
      message: { message_id: 'om_3', chat_id: 'oc_g', chat_type: 'group', message_type: 'file', content: '{"file_key":"file_k","file_name":"a.pdf"}' },
    }, 'ou_bot')).toBeNull();
  });
});

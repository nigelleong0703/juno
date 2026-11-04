/** Slack Web API sender: `chat.postMessage`, replying in the thread when the threadId carries one. */
import { renderMentions } from '../mentions.js';
import type { RichMessage } from '../render.js';
import { httpFailure, retryAfterMsOf, type SendFailure } from '../failure.js';
import type { ChannelSender, ChannelSendResult, ChannelSendTarget } from '../types.js';
import { slackIdentity } from './api.js';
import { slackApiBase } from './base.js';
import { slackMessages } from './render.js';
import { sendSlackFile } from './abilities.js';

/** A reply longer than this goes out as a canvas (or, where the workspace does not allow one, a file), not as a wall of messages. */
export const LONG_RESULT_CHARS = 8000;

/**
 * A long result as a canvas in the channel (`canvases.create` with `channel_id`, scope canvases:write; a free workspace may only add
 * a canvas to a channel as a tab and one per channel: docs.slack.dev/reference/methods/canvases.create), else as a Markdown file in
 * the thread. The message in the thread says where it is. Undefined when neither worked: the text then goes out as messages.
 */
async function sendLongResult(fetchFn: typeof fetch, target: ChannelSendTarget, rich: RichMessage): Promise<ChannelSendResult | undefined> {
  const title = (rich.text.split('\n').find((line) => line.trim() !== '') ?? 'Result').replace(/[*#_`]/g, '').trim().slice(0, 80) || 'Result';
  const summary = rich.text.slice(0, 400).replace(/\s+\S*$/, '') + '…';
  const headers = { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer ' + (target.channel.botToken ?? '') };
  const canvas = await fetchFn(slackApiBase() + 'canvases.create', {
    method: 'POST', headers, body: JSON.stringify({ title, document_content: { type: 'markdown', markdown: rich.text }, channel_id: target.chatId }),
  }).then((response) => response.json() as Promise<Record<string, unknown>>).catch(() => ({} as Record<string, unknown>));
  if (canvas['ok'] === true) return sendSlackRich(fetchFn, target, { ...rich, text: summary + '\n\nThe full result is in the canvas "' + title + '" of this channel.', buttons: [] });
  const uploaded = await sendSlackFile(fetchFn, { token: target.channel.botToken ?? '' }, { chatId: target.chatId, threadId: target.threadId }, { name: 'result.md', mime: 'text/markdown', bytes: new TextEncoder().encode(rich.text) }, summary);
  return uploaded.status === 'ok' ? { ok: true } : undefined;
}

export async function sendSlackRich(fetchFn: typeof fetch, target: ChannelSendTarget, rich: RichMessage): Promise<ChannelSendResult> {
  if (rich.buttons.length === 0 && rich.text.length > LONG_RESULT_CHARS) {
    const long = await sendLongResult(fetchFn, target, rich);
    if (long !== undefined) return long;
  }
  const sep = target.threadId.indexOf(':');
  const threadTs = sep === -1 ? undefined : target.threadId.slice(sep + 1);
  let firstTs: string | undefined;
  for (const message of slackMessages(rich)) {
    const posted = await postSlackMessage(fetchFn, target, { ...message, ...(threadTs === undefined ? {} : { thread_ts: threadTs }) });
    if (!posted.ok) return posted;
    if (firstTs === undefined && posted.externalId !== undefined) firstTs = posted.externalId;
  }
  return firstTs === undefined ? { ok: true } : { ok: true, externalId: firstTs };
}

/** Slack answers HTTP 200 with `ok: false` and an error code (https://docs.slack.dev/reference/methods/chat.postMessage): these codes say what to do next. */
const SLACK_TOKEN_ERRORS = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired']);
const SLACK_CHAT_ERRORS = new Set(['channel_not_found', 'is_archived', 'not_in_channel', 'restricted_action', 'access_denied']);
const SLACK_RETRY_ERRORS = new Set(['ratelimited', 'rate_limited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout']);

export function slackFailure(status: number, error: string | undefined, retryAfterMs: number | undefined): SendFailure {
  if (error !== undefined && SLACK_TOKEN_ERRORS.has(error)) return { kind: 'token_invalid' };
  if (error !== undefined && SLACK_CHAT_ERRORS.has(error)) return { kind: 'channel_gone' };
  if (error !== undefined && SLACK_RETRY_ERRORS.has(error)) return { kind: 'transient', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  // An error code that is not in the lists on a 200 means this message was refused (too long, bad blocks); a real HTTP error status reads as usual.
  return status === 200 && error !== undefined ? { kind: 'content_rejected' } : httpFailure(status, retryAfterMs);
}

/** One `chat.postMessage`; the platform's `ts` is the message id. */
async function postSlackMessage(fetchFn: typeof fetch, target: ChannelSendTarget, message: Record<string, unknown>): Promise<ChannelSendResult> {
  let response: Response;
  try {
    response = await fetchFn(slackApiBase() + 'chat.postMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer ' + (target.channel.botToken ?? '') },
      body: JSON.stringify({ channel: target.chatId, ...message, ...slackIdentity(target) }),
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), failure: { kind: 'transient' } };
  }
  const retryAfterMs = retryAfterMsOf(response.headers.get('retry-after') ?? undefined);
  if (response.status === 429) return { ok: false, error: 'Slack rate limited; retry after ' + (response.headers.get('retry-after') ?? 'unknown') + 's', failure: slackFailure(429, 'ratelimited', retryAfterMs) };
  const payload: unknown = await response.json().catch(() => null);
  const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  if (!response.ok || record['ok'] !== true) {
    const error = typeof record['error'] === 'string' ? record['error'] : undefined;
    return { ok: false, error: 'Slack send failed: ' + (error ?? String(response.status)), failure: slackFailure(response.status, error, retryAfterMs) };
  }
  return typeof record['ts'] === 'string' ? { ok: true, externalId: record['ts'] } : { ok: true };
}

export function createSlackSender(fetchFn: typeof fetch = fetch): ChannelSender {
  return {
    async sendText(target: ChannelSendTarget, text: string): Promise<ChannelSendResult> {
      const sep = target.threadId.indexOf(':');
      const threadTs = sep === -1 ? undefined : target.threadId.slice(sep + 1);
      return postSlackMessage(fetchFn, target, { text: renderMentions(text, (person) => '<@' + person.id + '>'), ...(threadTs === undefined ? {} : { thread_ts: threadTs }) });
    },
    sendRich: (target, rich) => sendSlackRich(fetchFn, target, rich),
    // conversations.open (scope im:write): the DM with a person, so a card for the owner can reach them even before they wrote to the bot.
    async openDirect(token, userId) {
      try {
        const response = await fetchFn(slackApiBase() + 'conversations.open', {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer ' + token },
          body: JSON.stringify({ users: userId }),
        });
        const payload: unknown = await response.json().catch(() => null);
        const channel = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)['channel'] : undefined;
        const id = typeof channel === 'object' && channel !== null ? (channel as Record<string, unknown>)['id'] : undefined;
        return typeof id === 'string' ? id : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

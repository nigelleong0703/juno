/** Slack Web API sender: `chat.postMessage`, replying in the thread when the threadId carries one. */
import { renderMentions } from '../mentions.js';
import type { RichMessage } from '../render.js';
import type { ChannelSender, ChannelSendResult, ChannelSendTarget } from '../types.js';
import { slackIdentity } from './api.js';
import { slackMessages } from './render.js';

export async function sendSlackRich(fetchFn: typeof fetch, target: ChannelSendTarget, rich: RichMessage): Promise<ChannelSendResult> {
  const sep = target.threadId.indexOf(':');
  const threadTs = sep === -1 ? undefined : target.threadId.slice(sep + 1);
  let firstTs: string | undefined;
  for (const message of slackMessages(rich)) {
    let response: Response;
    try {
      response = await fetchFn('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer ' + (target.channel.botToken ?? '') },
        body: JSON.stringify({ channel: target.chatId, ...message, ...(threadTs === undefined ? {} : { thread_ts: threadTs }), ...slackIdentity(target) }),
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (response.status === 429) return { ok: false, error: 'Slack rate limited; retry after ' + (response.headers.get('retry-after') ?? 'unknown') + 's' };
    const payload: unknown = await response.json().catch(() => null);
    const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    if (!response.ok || record['ok'] !== true) {
      const error = record['error'];
      return { ok: false, error: 'Slack send failed: ' + (typeof error === 'string' ? error : String(response.status)) };
    }
    if (firstTs === undefined && typeof record['ts'] === 'string') firstTs = record['ts'];
  }
  return firstTs === undefined ? { ok: true } : { ok: true, externalId: firstTs };
}

export function createSlackSender(fetchFn: typeof fetch = fetch): ChannelSender {
  return {
    async sendText(target: ChannelSendTarget, text: string): Promise<ChannelSendResult> {
      const sep = target.threadId.indexOf(':');
      const threadTs = sep === -1 ? undefined : target.threadId.slice(sep + 1);
      let response: Response;
      try {
        response = await fetchFn('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer ' + (target.channel.botToken ?? '') },
          body: JSON.stringify({ channel: target.chatId, text: renderMentions(text, (person) => '<@' + person.id + '>'), ...(threadTs === undefined ? {} : { thread_ts: threadTs }), ...slackIdentity(target) }),
        });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (response.status === 429) {
        return { ok: false, error: 'Slack rate limited; retry after ' + (response.headers.get('retry-after') ?? 'unknown') + 's' };
      }
      const payload: unknown = await response.json().catch(() => null);
      const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
      if (!response.ok || record['ok'] !== true) {
        const error = record['error'];
        return { ok: false, error: 'Slack send failed: ' + (typeof error === 'string' ? error : String(response.status)) };
      }
      const ts = record['ts'];
      return typeof ts === 'string' ? { ok: true, externalId: ts } : { ok: true };
    },
    sendRich: (target, rich) => sendSlackRich(fetchFn, target, rich),
  };
}

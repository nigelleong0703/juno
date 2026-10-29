import { getJson, record, str } from '../http.js';
import { HISTORY_FETCH_LIMIT as FETCH_LIMIT, type ChannelMessage, type HistoryFetcher } from '../types.js';
import { resolveSlackMentions, slackUserNamer } from './mentions.js';

const BASE = 'https://slack.com/api/';

/**
 * The thread before the trigger, else the channel's recent messages, oldest first. A message posted by an app (`bot_id`) is a bot
 * message whose name is the `username` it was posted under (a shared app speaks as an agent); `author.id` is its user id.
 */
export const fetchSlackHistory: HistoryFetcher = async (fetchFn, token, chat) => {
  const headers = { authorization: 'Bearer ' + token };
  const limit = String(chat.limit ?? FETCH_LIMIT);
  const beforeMs = chat.beforeAt === undefined ? NaN : Date.parse(chat.beforeAt);
  const triggerTs = Number.isFinite(beforeMs) ? (beforeMs / 1000).toFixed(6) : chat.beforeId === undefined ? undefined : chat.beforeId.slice(chat.beforeId.indexOf(':') + 1);
  const latest = triggerTs === undefined ? '' : '&latest=' + triggerTs;
  const sep = chat.threadId.indexOf(':');
  const threadTs = sep === -1 ? undefined : chat.threadId.slice(sep + 1);
  let messages: unknown[] = [];
  if (threadTs !== undefined && triggerTs !== undefined) {
    const replies = record(await getJson(fetchFn, BASE + 'conversations.replies?channel=' + chat.chatId + '&ts=' + threadTs + '&latest=' + triggerTs + '&limit=' + limit, headers));
    if (replies['ok'] === true && Array.isArray(replies['messages'])) messages = replies['messages'].filter((m) => str(record(m)['ts']) !== triggerTs);
  }
  // A top-level mention starts its own thread, so there is nothing in it yet: the channel's recent messages are the context.
  if (messages.length === 0) {
    const history = record(await getJson(fetchFn, BASE + 'conversations.history?channel=' + chat.chatId + latest + '&limit=' + limit, headers));
    if (history['ok'] !== true || !Array.isArray(history['messages'])) return undefined;
    messages = [...history['messages']].reverse();
  }
  const nameOf = slackUserNamer(fetchFn, token);
  const out: ChannelMessage[] = [];
  for (const raw of messages) {
    const msg = record(raw);
    const source = str(msg['text']);
    if (source === undefined) continue;
    const { text, mentions } = await resolveSlackMentions(nameOf, source);
    const user = str(msg['user']);
    const ts = str(msg['ts']) ?? '';
    const isBot = str(msg['bot_id']) !== undefined;
    const name = isBot ? (str(msg['username']) ?? str(record(msg['bot_profile'])['name']) ?? 'bot') : user === undefined ? (str(msg['username']) ?? 'bot') : await nameOf(user);
    out.push({ id: ts, at: Number.isFinite(Number(ts)) && ts !== '' ? new Date(Number(ts) * 1000).toISOString() : '', text, author: { id: user ?? str(msg['bot_id']) ?? '', name, isBot }, ...(mentions.length === 0 ? {} : { mentions }) });
  }
  return out;
};

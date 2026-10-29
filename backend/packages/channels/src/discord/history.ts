import { z } from 'zod';
import { getJson, record, str } from '../http.js';
import { HISTORY_FETCH_LIMIT as FETCH_LIMIT, type ChannelMessage, type HistoryFetcher } from '../types.js';
import { DISCORD_API, discordUserSchema, rewriteDiscordMentions, rewriteDiscordRoles } from './api.js';

const mentionsSchema = z.array(discordUserSchema()).catch([]);

/** The snowflake id Discord would give a message sent at this ISO time, so "before this time" is a `before=` id. */
function snowflakeAt(iso: string): string | undefined {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ((BigInt(ms) - 1420070400000n) << 22n).toString() : undefined;
}

/** The messages just before the one that woke the agent (absent: the newest ones), oldest first, with mentions read as `@Name`. */
export const fetchDiscordHistory: HistoryFetcher = async (fetchFn, token, chat) => {
  const beforeId = chat.beforeAt === undefined ? chat.beforeId : snowflakeAt(chat.beforeAt) ?? chat.beforeId;
  const before = beforeId === undefined ? '' : '&before=' + beforeId;
  const body = await getJson(fetchFn, DISCORD_API + '/channels/' + chat.chatId + '/messages?limit=' + String(Math.min(chat.limit ?? FETCH_LIMIT, 100)) + before, { authorization: 'Bot ' + token });
  if (!Array.isArray(body)) return undefined;
  return body.map(record).reverse().flatMap((msg): ChannelMessage[] => {
    const author = record(msg['author']);
    const content = str(msg['content']);
    const webhookId = str(msg['webhook_id']);
    if (content === undefined) return [];
    const rewritten = rewriteDiscordMentions(rewriteDiscordRoles(content, chat.roleNames), mentionsSchema.parse(msg['mentions']), '');
    const username = str(author['username']);
    return [{
      id: str(msg['id']) ?? '',
      at: str(msg['timestamp']) ?? '',
      text: rewritten.text,
      author: {
        id: str(author['id']) ?? '',
        name: str(author['global_name']) ?? username ?? 'someone',
        isBot: author['bot'] === true || webhookId !== undefined,
        ...(username === undefined ? {} : { handle: username }),
        ...(webhookId === undefined ? {} : { webhookId }),
      },
      ...(rewritten.mentions.length === 0 ? {} : { mentions: rewritten.mentions }),
    }];
  });
};

/**
 * What a group reply needs from the platform before it is sent; each platform's adapter has its own planner (`sdk.ts` puts it on the
 * sender as `planReply`):
 * - whether it quotes the message that addressed the agent (only when someone other than our own app posted after it; never in a
 *   private chat; unknown quotes), see @agent-desktop/channels/quote;
 * - the people it may mention: whoever wrote or was mentioned in the chat's recent messages (the sender of the triggering message
 *   is among them), fetched from the platform only when the reply contains an `@`. Nothing is stored.
 * Any lookup failure means no mentions and no quote.
 */
import { discordOthersAfter } from './discord/api.js';
import { fetchDiscordHistory } from './discord/history.js';
import { shouldQuote } from './quote.js';
import { fetchSlackHistory } from './slack/history.js';
import type { ChannelMessage, ChannelPerson, ChannelSender, ReplyPlan } from './types.js';

/** Every human who wrote or was mentioned in these messages, once per platform id. */
export function peopleIn(messages: ChannelMessage[]): ChannelPerson[] {
  const seen = new Map<string, ChannelPerson>();
  for (const message of messages) {
    const { isBot: _bot, webhookId: _hook, ...author } = message.author;
    if (!message.author.isBot && author.id !== '') seen.set(author.id, author);
    for (const person of message.mentions ?? []) seen.set(person.id, person);
  }
  return [...seen.values()];
}

type ReplyPlanner = NonNullable<ChannelSender['planReply']>;
type GroupChat = { chatId: string; threadId: string };

const NO_PLAN: ReplyPlan = { quote: false, people: [] };

/** A planner that answers only for groups (never a quote or a mention in a private chat) and turns a failed lookup into no plan. */
function groupPlanner(plan: (token: string, origin: Parameters<ReplyPlanner>[1], replyText: string, ours: Parameters<ReplyPlanner>[3], chat: GroupChat) => Promise<ReplyPlan>): ReplyPlanner {
  return async (token, origin, replyText, ours) => {
    if (origin.chatType !== 'group') return NO_PLAN;
    return plan(token, origin, replyText, ours, { chatId: origin.chatId, threadId: origin.threadId ?? origin.chatId }).catch(() => NO_PLAN);
  };
}

export const discordReplyPlanner = (fetchFn: typeof fetch): ReplyPlanner => groupPlanner(async (token, origin, replyText, ours, chat) => {
  const othersAfter = origin.messageId === undefined ? undefined : await discordOthersAfter(fetchFn, token, origin.chatId, origin.messageId, ours);
  const messages = replyText.includes('@') ? await fetchDiscordHistory(fetchFn, token, chat) : undefined;
  return { quote: shouldQuote({ chatType: 'group', ...(origin.messageId === undefined ? {} : { triggerId: origin.messageId }), ...(othersAfter === undefined ? {} : { othersAfter }) }), people: peopleIn(messages ?? []) };
});

/** Slack threads the reply with thread_ts (unchanged); there is no quote to decide. */
export const slackReplyPlanner = (fetchFn: typeof fetch): ReplyPlanner => groupPlanner(async (token, _origin, replyText, _ours, chat) => {
  const messages = replyText.includes('@') ? await fetchSlackHistory(fetchFn, token, chat) : undefined;
  return { quote: false, people: peopleIn(messages ?? []) };
});

/** Telegram's Bot API cannot say what the latest message is: quote. */
export const telegramReplyPlanner: ReplyPlanner = groupPlanner(async (_token, origin) => ({ quote: shouldQuote({ chatType: 'group', ...(origin.messageId === undefined ? {} : { triggerId: origin.messageId }) }), people: [] }));

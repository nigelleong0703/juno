import { getJson, record, str } from '../http.js';
import type { ChannelPerson } from '../types.js';

const MENTION = /<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g;

/** A cached `users.info` lookup of a user's display name (the id itself when Slack does not say). */
export function slackUserNamer(fetchFn: typeof fetch, token: string): (id: string) => Promise<string> {
  const names = new Map<string, string>();
  return async (id) => {
    const known = names.get(id);
    if (known !== undefined) return known;
    const info = record(record(await getJson(fetchFn, 'https://slack.com/api/users.info?user=' + id, { authorization: 'Bearer ' + token }))['user']);
    const name = str(record(info['profile'])['display_name']) ?? str(info['real_name']) ?? id;
    names.set(id, name);
    return name;
  };
}

/** `<@U123>` / `<@U123|name>` become `@Name` (the label Slack embeds, else a lookup). Slack has no unique handle. */
export async function resolveSlackMentions(nameOf: (id: string) => Promise<string>, text: string): Promise<{ text: string; mentions: ChannelPerson[] }> {
  const mentions: ChannelPerson[] = [];
  let out = '';
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    const id = match[1] ?? '';
    const name = str(match[2]) ?? (await nameOf(id));
    if (!mentions.some((seen) => seen.id === id)) mentions.push({ id, name });
    out += text.slice(last, match.index) + '@' + name;
    last = match.index + match[0].length;
  }
  return { text: out + text.slice(last), mentions };
}

/**
 * When a chat digest runs at all (BACKEND §5.4). A digest is one model call, so chatter gets none. In a direct chat one owner message
 * of at least 8 characters that is not a pure acknowledgement is enough: "Tom is Priya's manager" is a fact, however short. In a group one
 * message of 16 characters or more that is not an acknowledgement is enough, or the people's messages together must reach 40 characters.
 * Pure logic, no database.
 */

/** A group's human messages together must reach this many characters for a digest to run. */
export const MIN_GROUP_CHARS = 40;
/** Or one group message of this many characters that is not an acknowledgement ("We'll ship the release on Friday." is 33: enough alone). */
export const MIN_GROUP_MESSAGE_CHARS = 16;
/** A direct chat needs one owner message of at least this many characters (not an acknowledgement). */
export const MIN_OWNER_CHARS = 8;

/** Acknowledgements and small reactions, keyed as `keyOf` writes them (lower case, no spaces or punctuation). */
const ACKNOWLEDGEMENTS: ReadonlySet<string> = new Set([
  'ok', 'okay', 'k', 'kk', 'okthanks', 'okthankyou', 'thanks', 'thankyou', 'thanksalot', 'thx', 'ty', 'yes', 'yeah', 'yep', 'no', 'nope',
  'sure', 'cool', 'great', 'nice', 'good', 'fine', 'right', 'gotit', 'got', 'alright', 'perfect', 'lol', 'lmao', 'hehe',
  '好', '好的', '好的谢谢', '嗯', '嗯嗯', '哦', '哦哦', '谢谢', '谢谢你', '谢谢啦', '收到', '行', '行的', '可以', '明白', '知道了', '了解',
]);

/** Laughter in any of the usual scripts: "haha", "hahaha", "呵呵", "哈哈哈". */
const LAUGHTER = /^(ha|he|呵|哈|嘿|嘻)+$/u;

/** The text with case, spaces and punctuation, symbols and emoji removed: what an acknowledgement is compared by. */
const keyOf = (text: string): string => text.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');

/** A message that says nothing new: empty once punctuation and emoji are gone, an acknowledgement, or laughter. */
export function isAcknowledgement(text: string): boolean {
  const key = keyOf(text);
  return key === '' || ACKNOWLEDGEMENTS.has(key) || LAUGHTER.test(key);
}

const collapsed = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Whether the messages since the last digest are worth a model call. `direct` is a chat with no group in it (the owner and the agent,
 * or a platform DM); `messages` are the human messages of the window (`role` `user` is the owner, `other` a room member).
 */
export function worthDigesting(messages: ReadonlyArray<{ role: string; text: string }>, direct: boolean): boolean {
  if (direct) {
    return messages.some((message) => message.role === 'user' && collapsed(message.text).length >= MIN_OWNER_CHARS && !isAcknowledgement(message.text));
  }
  const oneSaysEnough = messages.some((message) => collapsed(message.text).length >= MIN_GROUP_MESSAGE_CHARS && !isAcknowledgement(message.text));
  return oneSaysEnough || messages.reduce((sum, message) => sum + collapsed(message.text).length, 0) >= MIN_GROUP_CHARS;
}

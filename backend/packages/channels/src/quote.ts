/**
 * Quote-replies only when needed. A private chat never quotes (the reply obviously answers the last message). In a group a reply
 * quotes the message that addressed the agent only once someone other than our own app has posted after it, so the answer is still
 * attributable (our own acknowledgement bubble does not count). `othersAfter` is what the platform's lookup says; undefined (the
 * platform cannot say, or the lookup failed) quotes, because dropping the quote then could leave the reply orphaned.
 */
export function shouldQuote(chat: { chatType?: 'private' | 'group'; triggerId?: string; othersAfter?: boolean }): boolean {
  if (chat.chatType === 'private' || chat.triggerId === undefined) return false;
  return chat.othersAfter ?? true;
}

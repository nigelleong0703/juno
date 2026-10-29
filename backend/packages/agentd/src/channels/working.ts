/**
 * The "working" indicator of a platform chat: when an inbound message wakes the agent, react to it with 👀 so people see it was
 * picked up; when the conversation's run finishes (any outcome) the reaction comes off. Part of channel delivery, not a model tool,
 * and best-effort: a refused or failed reaction is ignored and never fails the wake or the run. It uses the platform's `react` and
 * `unreact` abilities, so it appears only where the chat's capability row has reactions (an emoji the platform lacks is skipped).
 *
 * A platform opts out with `workingIndicator: false` in its plugin. Telegram does, on purpose: the Bot API has no typing action in our sender, and a reaction there is replaced rather than
 * taken off, so a working mark is not worth it. Marks are kept in memory: a restart while a run is going leaves its 👀 on the message,
 * and a mark nobody finished is taken off after MAX_MS.
 */
import { createLogger } from '@agent-desktop/log';
import type { Store } from '@agent-desktop/contracts';
import { chatCapabilities, reactionAllowed, type ChannelOrigin } from '@agent-desktop/public-contracts';
import { chatAccess } from './port.js';
import type { ChannelRegistry } from './registry.js';

const log = createLogger({ service: 'agentd' });

export const WORKING_EMOJI = '👀';
const MAX_MS = 30 * 60_000;

interface Mark {
  remove(): Promise<void>;
  timer: NodeJS.Timeout;
}

const marks = new Map<string, Mark[]>();

/** React to the message that woke the agent in this conversation; remembered until `finishWorking`. Never throws. */
export async function startWorking(
  deps: { store: Store; channels: ChannelRegistry; channelFetch?: typeof fetch },
  ownerId: string,
  conversationId: string,
  origin: ChannelOrigin,
  messageId: string,
): Promise<void> {
  try {
    if (deps.channels.get(origin.kind)?.workingIndicator !== true) return;
    const chat = await chatAccess(deps.store, deps.channels, ownerId, origin);
    if (chat === undefined || !reactionAllowed(chatCapabilities(origin.kind, chat.row.grantedScopes ?? []).reactions, WORKING_EMOJI)) return;
    const fetchFn = deps.channelFetch ?? fetch;
    const message = { chatId: origin.chatId, messageId };
    const reacted = await chat.abilities.react(fetchFn, chat.auth, message, WORKING_EMOJI);
    if (reacted.status !== 'ok') return;
    const mark: Mark = {
      remove: async () => {
        clearTimeout(mark.timer);
        const result = await chat.abilities.unreact(fetchFn, chat.auth, message, WORKING_EMOJI, reacted.value.reactionId);
        if (result.status === 'failed') log.warn({ conversationId, error: result.error }, 'working reaction not removed');
      },
      timer: setTimeout(() => { void mark.remove().catch(() => undefined); }, MAX_MS),
    };
    mark.timer.unref();
    marks.set(conversationId, [...(marks.get(conversationId) ?? []), mark]);
  } catch (err) {
    log.warn({ err, conversationId }, 'working reaction skipped');
  }
}

/** Take the working reactions of this conversation off. Never throws. */
export async function finishWorking(conversationId: string): Promise<void> {
  const pending = marks.get(conversationId);
  if (pending === undefined) return;
  marks.delete(conversationId);
  for (const mark of pending) await mark.remove().catch((err: unknown) => log.warn({ err, conversationId }, 'working reaction not removed'));
}

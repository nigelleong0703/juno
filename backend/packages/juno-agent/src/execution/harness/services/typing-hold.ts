/**
 * Hold a ready final reply while the user is still typing, like a person who waits for you to finish
 * your thought before answering. Private chats only (never child runs). The wait is
 * built from journaled calls and sleeps only, so a replay walks the same iterations.
 */
import { CANCELLED, type RunCancellation } from './cancel.js';
import type { RunContext, RunInput, RunServices } from './run-types.js';
import { isPrivateConversation, MAX_TYPING_HOLD_MS } from '../logic/idle.js';
import type { ConversationKind } from '@agent-desktop/public-contracts';

const HOLD_POLL_MS = 1000;

/** Returns CANCELLED when the run was stopped while holding; otherwise once it is fine to post (or to answer a newer message). */
export async function holdWhileTyping(
  ctx: RunContext,
  services: RunServices,
  input: RunInput,
  stepIndex: number,
  cancellation: RunCancellation,
  isChild: boolean,
): Promise<typeof CANCELLED | 'go'> {
  const read = ctx.typingState;
  const sleep = ctx.sleep;
  if (read === undefined || sleep === undefined || isChild) return 'go';
  const kind = await ctx.run(`hold-kind:${stepIndex}`, async (): Promise<ConversationKind | undefined> =>
    (await services.store.get('conversations', input.conversationId))?.kind);
  if (!isPrivateConversation(kind)) return 'go';

  const clock = (name: string): Promise<number> =>
    ctx.date === undefined ? ctx.run(name, async () => Date.now()) : ctx.date.now();
  const heldFrom = await clock(`hold-start:${stepIndex}`);
  for (let round = 0; ; round += 1) {
    const seen = await cancellation.race(() => read());
    if (seen === CANCELLED) return CANCELLED;
    const now = await clock(`hold-clock:${stepIndex}:${round}`);
    // Done typing, a newer message is waiting (the caller's steer check will take it), or held long enough.
    if (seen.typingUntil === null || seen.typingUntil <= now || seen.steerQueued > 0 || now - heldFrom >= MAX_TYPING_HOLD_MS) return 'go';
    if ((await cancellation.race(() => sleep(HOLD_POLL_MS))) === CANCELLED) return CANCELLED;
  }
}

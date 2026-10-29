/**
 * The final reply bubble for one run loop.
 *
 * A final turn's text is shown to the user as bubbles (see reply-layout.ts) unless it is blank or repeats text the
 * conversation already received (an earlier send_message bubble or an earlier final). Only an
 * identical repeat is dropped, so real progress and a meaningful final stay visible while a model
 * that restates what the user just read never double-posts it.
 */
import type { RestatePromise } from '@agent-desktop/durable';
import { CANCELLED, type RunCancellation } from './cancel.js';
import type { RunContext, RunInput, RunServices } from './run-types.js';
import { isChildRun, storeChildResult } from '../../../modules/tasks/childDelivery.js';
import { emitItemAdded } from '../../conversation-activity.js';
import type { UiDoc } from '@agent-desktop/public-contracts';
import { replyOriginOf } from '../../../modules/channel-origin.js';
import { layoutReply, layoutSingleMessage, readingPauseMs, type ReplyBubble } from './reply-layout.js';
import { countStreamed, reconcileStreamed, streamedItemId, type StreamedState } from './block-stream.js';
import { isAutomaticWake } from '../../brain/messages.js';
import { countedKind, hasRoomToPost, logPosted } from '../../../modules/proactive/service.js';

/** A source a web tool returned (the public Citation shape). */
export interface ReplyCitation { id: string; title: string; url?: string; source?: string }

/** Most citations one reply carries. */
export const MAX_REPLY_CITATIONS = 8;

/** Read the citations a tool result's details carry; anything malformed is skipped. */
export function citationsOf(details: unknown): ReplyCitation[] {
  const raw: unknown = typeof details === 'object' && details !== null ? Reflect.get(details, 'citations') : undefined;
  if (!Array.isArray(raw)) return [];
  const out: ReplyCitation[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const [id, title, url, source]: unknown[] = ['id', 'title', 'url', 'source'].map((key) => Reflect.get(entry, key));
    if (typeof id !== 'string' || typeof title !== 'string' || title === '') continue;
    out.push({ id, title, ...(typeof url === 'string' ? { url } : {}), ...(typeof source === 'string' ? { source } : {}) });
  }
  return out;
}

/** Dedupe by url (else id), put sources the reply links or mentions first, keep first-use order otherwise, cap. */
export function selectCitations(collected: ReplyCitation[], replyText: string): ReplyCitation[] {
  const seen = new Set<string>();
  const unique = collected.filter((citation) => {
    const key = citation.url ?? citation.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const mentioned = (citation: ReplyCitation): boolean => citation.url !== undefined && replyText.includes(citation.url);
  return [...unique.filter(mentioned), ...unique.filter((citation) => !mentioned(citation))].slice(0, MAX_REPLY_CITATIONS);
}

/** The durable action's result; `ctx.run` journals this JSON shape. */
type ReplyOutcome = { posted: boolean };

/** A final reply held back because its card was invalid: `hint` goes to the model, which answers again. */
export interface ReplyRetry { retry: string }

/** Once per run a reply with an invalid card is sent back to the model instead of being posted. */
export interface CardRetryBudget { used: boolean }

const cardRetryHint = (errors: string[]): string =>
  `Your last reply was not posted: its card is invalid (${errors.join('; ')}). Send the whole reply again with a valid card (exactly the shape of send_message's ui parameter, display blocks only) or without a card.`;

/** Tools that never announce themselves with an opening line (ackStep). */
const QUIET_TOOLS = new Set(['memory_note', 'react']);

/** True when a final turn carries no user-visible text, so no bubble should be posted. */
export function isBlankReply(text: string): boolean {
  return text.trim().length === 0;
}

/** True when this exact text already reached this conversation, so re-posting it would duplicate it. */
export function isDuplicateDelivery(text: string, deliveredTexts: string[]): boolean {
  const trimmed = text.trim();
  return deliveredTexts.some((delivered) => delivered.trim() === trimmed);
}

/**
 * Post a final turn's text as its own bubble, durable and raced against cancel so a stop never posts a
 * reply. The action rechecks cancellation before writing: a late race loss must not leave a stale item
 * behind. Only deliveries recorded for this conversation suppress a reply (see run-tools).
 */
export async function replyStep(
  ctx: RunContext,
  services: RunServices,
  input: RunInput,
  stepIndex: number,
  text: string,
  cancellation: RunCancellation,
  deliveredTexts: string[],
  /** PH12: the run that produced this reply, written on the item so a bubble links to its task. */
  runId?: string,
  /** Sources web_search/web_fetch returned during the run; attached to the stored bubble only. */
  citations: ReplyCitation[] = [],
  /** The run's single card retry; absent means the reply must be posted now (cards dropped if broken). */
  retry?: CardRetryBudget,
): Promise<typeof CANCELLED | 'completed' | 'silent' | ReplyRetry> {
  // The final reply is the message the people in this chat see, for every run (a routine, a calendar wake
  // and a finished task included). A blank one (the model has nothing to say, or already said it through
  // send_message) never writes an item.
  if (isBlankReply(text)) return 'silent';
  // CT: the child classification is a journalled read, so a replay re-derives the same branch.
  const childRunId = runId;
  let child = false;
  if (childRunId !== undefined) {
    child = await ctx.run(`child-classify:${stepIndex}`, async () => {
      const run = await services.store.get('runs', childRunId);
      return isChildRun(run);
    });
  }
  if (child && childRunId !== undefined) {
    // A child run is a silent work item: its final text becomes the canonical childResult on the
    // run row (emitted as run.updated); it never becomes a chat bubble or a user question.
    if (isDuplicateDelivery(text, deliveredTexts)) return 'completed';
    const outcome = await cancellation.race((): RestatePromise<boolean> => ctx.run(`child-reply:${stepIndex}`, () =>
      storeChildResult(services, { runId: childRunId, agentId: input.agentId, conversationId: input.conversationId, text }, cancellation),
    ));
    if (outcome === CANCELLED || !outcome) return CANCELLED;
    deliveredTexts.push(text);
    return 'completed';
  }
  const streams = blockStreaming(input);
  if (isDuplicateDelivery(text, deliveredTexts)) {
    if (streams) await discardStreamed(ctx, services, input, stepIndex, runId);
    return 'completed';
  }
  // A run nobody is waiting on (an automatic wake) posts one message: one bubble, one notification.
  const automatic = !streams;
  // Bubbles already posted while the model wrote the reply (block streaming): the layout keeps them in place.
  const streamedCount = streams && runId !== undefined ? await ctx.run(`reply:${stepIndex}:streamed`, () => countStreamed(services, runId, stepIndex)) : 0;
  const layout = automatic ? layoutSingleMessage(text) : layoutReply(text, streamedCount);
  if (layout.cardErrors.length > 0) {
    if (retry !== undefined && !retry.used) {
      retry.used = true;
      if (streams) await discardStreamed(ctx, services, input, stepIndex, runId);
      return { retry: cardRetryHint(layout.cardErrors) };
    }
    services.log?.({ runId, errors: layout.cardErrors }, 'reply card dropped');
  }
  // Never leave the user without a reply: when nothing usable remains, the raw text is the one bubble.
  const bubbles = layout.bubbles.length > 0 ? layout.bubbles : [{ markdown: text.trim() }];
  // An unsolicited message (the daily check, a scheduled goal check-in) counts against the owner's daily cap, counted from what was posted: past it the reply is dropped with a log line.
  const counted = countedKind(input.wakeEvents);
  const wake = input.wakeEvents[0];
  if (counted !== undefined && wake !== undefined && !(await ctx.run(`proactive-room:${stepIndex}`, () => hasRoomToPost(services.store, wake.ownerId)))) {
    services.log?.({ runId, ownerId: wake.ownerId, kind: counted }, 'proactive message dropped: daily cap reached');
    return 'silent';
  }
  if ((await postBubbles(ctx, services, input, `reply:${stepIndex}`, stepIndex, bubbles, cancellation, runId, selectCitations(citations, text))) === CANCELLED) return CANCELLED;
  if (counted !== undefined && wake !== undefined) await ctx.run(`proactive-log:${stepIndex}`, async () => { await logPosted(services.store, { kind: counted, wake, ...(runId === undefined ? {} : { runId }) }); return true; });
  deliveredTexts.push(text);
  return 'completed';
}

/**
 * The opening line of a run that goes to work. The text the model wrote with its first tool calls
 * ("Checking flights now") is posted as its own bubble in a direct chat, so the user sees the work
 * start; text between later tool calls stays private (the turn driver silences those previews) and
 * the final reply carries the result. Not in rooms (every agent would announce itself), child runs
 * (silent work items), runs no user message started (a completion wake, a routine), or when the turn
 * already sends a message.
 */
export async function ackStep(
  ctx: RunContext,
  services: RunServices,
  input: RunInput,
  stepIndex: number,
  text: string,
  toolNames: string[],
  cancellation: RunCancellation,
  deliveredTexts: string[],
  runId?: string,
): Promise<typeof CANCELLED | 'posted' | 'skipped'> {
  // Block streaming may already have posted the paragraphs of this turn's text; when no opening line is shown they are taken back.
  const skipped = async (): Promise<'skipped'> => {
    if (blockStreaming(input)) await discardStreamed(ctx, services, input, stepIndex, runId);
    return 'skipped';
  };
  if (isBlankReply(text) || deliveredTexts.length > 0 || toolNames.includes('send_message')) return skipped();
  // The opening line answers the user's own message ("on it"); a run woken by finished background work has nobody waiting to hear it started.
  if (!input.wakeEvents.some((event) => event.kind === 'user_message')) return skipped();
  // Noting something is a quiet act, not work the user waits on: "let me note that down" would narrate memory.
  if (toolNames.every((name) => QUIET_TOOLS.has(name))) return skipped();
  const kind = await ctx.run(`ack-kind:${stepIndex}`, async () => {
    const conversation: unknown = await services.store.get('conversations', input.conversationId);
    const value = typeof conversation === 'object' && conversation !== null ? Reflect.get(conversation, 'kind') : undefined;
    return typeof value === 'string' ? value : '';
  });
  if (kind !== 'direct') return skipped();
  // One bubble, as ever; only when paragraphs were already streamed does the rest follow the layout they use.
  const streamedCount = runId === undefined ? 0 : await ctx.run(`ack:${stepIndex}:streamed`, () => countStreamed(services, runId, stepIndex));
  const bubbles = streamedCount > 0 ? layoutReply(text, streamedCount).bubbles : [{ markdown: text }];
  if ((await postBubbles(ctx, services, input, `ack:${stepIndex}`, stepIndex, bubbles, cancellation, runId, [])) === CANCELLED) return CANCELLED;
  deliveredTexts.push(text);
  return 'posted';
}

/** Whether this run's reply is posted as paragraph bubbles while the model writes it: not an automatic wake (one message, held until the daily-cap check). */
export function blockStreaming(input: RunInput): boolean {
  return !(input.wakeEvents.length > 0 && input.wakeEvents.every(isAutomaticWake));
}

/**
 * Several agent bubbles, in order, paced: the first at once, each later one after a durable reading pause
 * (readingPauseMs), each in its own durable step. With a run id the ids are (run, step, index), the ones block
 * streaming used: bubbles already posted while the model wrote are reconciled with this layout first (rewritten
 * or deleted), and only the rest is posted, its first bubble paced from the last streamed post. Without one the
 * ids are drawn before any step so a replay writes the same items. `at` is the real post time; the citations
 * ride on the last bubble only.
 */
async function postBubbles(
  ctx: RunContext,
  services: RunServices,
  input: RunInput,
  key: string,
  stepIndex: number,
  bubbles: ReplyBubble[],
  cancellation: RunCancellation,
  runId: string | undefined,
  citations: ReplyCitation[],
): Promise<typeof CANCELLED | 'posted'> {
  const ids = bubbles.map((_, index) => runId === undefined ? `itm_${ctx.rand.uuidv4()}` : streamedItemId(runId, stepIndex, index));
  const replyTo = replyOriginOf(input.wakeEvents);
  const sleep = ctx.sleep;
  const streamed: StreamedState | undefined = runId === undefined ? undefined : await ctx.run(`${key}:reconcile`, () => reconcileStreamed(services, input, runId, stepIndex, bubbles, citations));
  const already = streamed?.existing ?? 0;
  for (const [index, bubble] of bubbles.entries()) {
    if (index < already) continue;
    // A reading pause before every bubble but the first; a stop during it posts nothing more. The run
    // is still working meanwhile, so the typing / working indicators stay on until it finishes. After
    // streamed bubbles the time since the last one already counts.
    const elapsed = index === already && streamed?.lastAt !== undefined ? streamed.now - streamed.lastAt : 0;
    const pause = readingPauseMs(bubble.markdown) - elapsed;
    if (index > 0 && sleep !== undefined && pause > 0) {
      if ((await cancellation.race(() => sleep(pause))) === CANCELLED) return CANCELLED;
    }
    const ui: UiDoc | undefined = bubble.ui;
    const outcome = await cancellation.race((): RestatePromise<ReplyOutcome> => ctx.run(`${key}:${index}`, async () => {
      if (cancellation.state.cancelled) return { posted: false };
      const item = {
        id: ids[index] ?? `itm_${index}`,
        conversationId: input.conversationId,
        type: 'agent_message' as const,
        agentId: input.agentId,
        markdown: bubble.markdown,
        citations: index === bubbles.length - 1 ? citations : [],
        ...(ui === undefined ? {} : { ui }),
        ...(runId === undefined ? {} : { runId }),
        ...(replyTo === undefined ? {} : { replyTo }),
        at: new Date().toISOString(),
      };
      const stored = await services.store.put('items', item, { conversationId: input.conversationId, ...(runId === undefined ? {} : { runId }) });
      await emitItemAdded(services.store, input.conversationId, stored);
      return { posted: true };
    }));
    if (outcome === CANCELLED || outcome.posted === false) return CANCELLED;
  }
  return 'posted';
}

export { readingPauseMs };

/**
 * Take back the bubbles streamed for a turn whose text is not shown after all (the turn went on to tools and
 * has no opening line, a correction replaced it, it repeats what the chat already has, its card was invalid).
 * A no-op when nothing was streamed. Live clients have no event to drop a bubble; they lose it on the next load.
 */
export async function discardStreamed(ctx: RunContext, services: RunServices, input: RunInput, stepIndex: number, runId: string | undefined): Promise<void> {
  if (runId === undefined) return;
  await ctx.run(`stream-discard:${stepIndex}`, async () => { await reconcileStreamed(services, input, runId, stepIndex, [], []); return true; });
}

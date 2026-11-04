/**
 * The final reply bubble for one run loop.
 *
 * A final turn's text is shown to the user as ONE bubble (see reply-layout.ts) unless it is blank or repeats text the
 * conversation already received (an earlier send_message bubble or an earlier final). Only an
 * identical repeat is dropped, so real progress and a meaningful final stay visible while a model
 * that restates what the user just read never double-posts it.
 */
import { TerminalError, type DurablePromise } from '@agent-desktop/durable';
import type { AssistantTurn } from '../../../contracts/index.js';
import { CANCELLED, type RunCancellation } from './cancel.js';
import type { RunContext, RunInput, RunServices } from './run-types.js';
import { hasSubagentParent, storeSubagentResult } from '../../../modules/tasks/subagentDelivery.js';
import { emitItemAdded } from '../../conversation-activity.js';
import type { UiDoc } from '@agent-desktop/public-contracts';
import { replyOriginOf } from '../../../modules/channel-origin.js';
import { layoutReply, type ReplyBubble } from './reply-layout.js';
import { NO_REPLY_FAILURE, REFUSED_FAILURE } from '../logic/plain-errors.js';
import { countedKind, hasRoomToPost, logPosted } from '../../../modules/proactive/service.js';
import { isVoiceWake } from '../../voice-channel.js';

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

/**
 * Whether a turn's calls (proxy calls unwrapped) start work that takes more than a few seconds: the browser or the computer, a helper
 * (subagent), or more than one search at once. The harness cannot know the duration in advance, so this is the kind of work.
 */
export function isLongWork(toolNames: readonly string[]): boolean {
  const searches = toolNames.filter((name) => /(^|[_.])search/.test(name) && name !== 'tool_search' && name !== 'skill_search');
  return toolNames.some((name) => name.startsWith('browser.') || name.startsWith('computer.') || name === 'subagent_start') || searches.length > 1;
}

/** Tools that never announce themselves with an opening line (ackStep). */
const QUIET_TOOLS = new Set(['memory_note', 'react']);

/**
 * Whether a model turn's calls (proxy calls already unwrapped) send a question card and nothing else through send_message: the card
 * ends the run, and any other send_message in the same turn would already say the text itself.
 */
export function asksQuestion(calls: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }>): boolean {
  const sends = calls.filter((call) => call.name === 'send_message');
  return sends.length > 0 && sends.every((call) => call.arguments['kind'] === 'question');
}

/** True when a final turn carries no user-visible text, so no bubble should be posted. */
export function isBlankReply(text: string): boolean {
  return text.trim().length === 0;
}

/** A final turn that gives the person nothing: no text at all, or the provider declined to answer (brain/model-refusal.ts). */
export function givesNothing(turn: Pick<AssistantTurn, 'text' | 'stopReason'>): boolean {
  return turn.stopReason === 'refusal' || isBlankReply(turn.text);
}

/** System wakes whose final text is the message a person gets (a finished task, a reminder, the first hello, a decision made, a private hand-off). */
const WAITED_ON_WAKES: ReadonlySet<string> = new Set(['task_done', 'hand_back', 'calendar_due', 'onboarding', 'request_resolved', 'private_handoff', 'capability_ready', 'capability_lost']);

/**
 * Whether a person is reading this run's final text (BACKEND §3.3 "empty or refused final reply"): the run does not speak only by
 * send_message, and its starting wake is one a person waits on. A reply from a peer agent and a live-meeting wake end silent by
 * design ("an empty reply ends the exchange", `meeting_say` is the only way into the meeting), so they are not covered.
 */
export function expectsReply(input: Pick<RunInput, 'wakeEvents' | 'sendOnly'>): boolean {
  if (input.sendOnly === true) return false;
  return input.wakeEvents.some((wake) => (wake.origin.type === 'user' && wake.payload['source'] !== 'meeting')
    || WAITED_ON_WAKES.has(wake.kind));
}

/** The run's one retry of an empty or refused final turn (run-wide, like the card retry). */
export interface NoReplyBudget { retried: boolean }

const NO_REPLY_HINT = 'Your last turn was empty. Answer the person now.';


/**
 * A final turn with nothing to show in a run someone waits on, with nothing delivered yet this run (no message, opening line,
 * reaction or feed post): the first time the model step is asked again with one short note ('retry'); the second time the run fails
 * with a reason code (`no_reply` or `refused`) and no invented text. Anything the run already said means the empty turn is fine ('fine').
 */
export async function emptyFinalStep(
  ctx: RunContext, services: RunServices, runId: string, turn: Pick<AssistantTurn, 'text' | 'stopReason'>, deliveredTexts: string[], budget: NoReplyBudget,
): Promise<'fine' | { retry: string }> {
  if (deliveredTexts.length > 0) return 'fine';
  // A reaction is the whole answer only to a message that needs nothing but a nod, which shows as a run that did nothing else: a run
  // that reacted and then searched, read or called anything has work to report, so its empty ending is retried. A feed post answers by itself.
  const answered = await ctx.run('no-reply:answered', async () => {
    const steps = (await services.store.get('runs', runId))?.steps ?? [];
    const done = steps.filter((step) => step.tool !== undefined && step.status === 'completed');
    return done.some((step) => step.tool === 'feed_post') || (done.some((step) => step.tool === 'react') && done.every((step) => step.tool !== undefined && QUIET_TOOLS.has(step.tool)));
  });
  if (answered) return 'fine';
  if (!budget.retried) {
    budget.retried = true;
    return { retry: NO_REPLY_HINT };
  }
  const code = turn.stopReason === 'refusal' ? 'refused' : 'no_reply';
  services.log?.({ runId, code }, 'run failed: no reply after a retry');
  throw new TerminalError(code === 'refused' ? REFUSED_FAILURE : NO_REPLY_FAILURE, { metadata: { code } });
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
  // The final reply is the message the people in this chat see, in every run someone waits on (a calendar wake and
  // a finished task the owner asked for included; a run nobody waits on keeps its text as a record line, `recordStep`).
  // A blank one (the model has nothing to say, or already said it through send_message) never writes an item.
  if (isBlankReply(text)) return 'silent';
  // CT: the child classification is a journalled read, so a replay re-derives the same branch.
  const childRunId = runId;
  let child = false;
  if (childRunId !== undefined) {
    child = await ctx.run(`child-classify:${stepIndex}`, async () => {
      const run = await services.store.get('runs', childRunId);
      return hasSubagentParent(run);
    });
  }
  if (child && childRunId !== undefined) {
    // A child run is a silent work item: its final text becomes the canonical childResult on the
    // run row (emitted as run.updated); it never becomes a chat bubble or a user question.
    if (isDuplicateDelivery(text, deliveredTexts)) return 'completed';
    const outcome = await cancellation.race((): DurablePromise<boolean> => ctx.run(`child-reply:${stepIndex}`, () =>
      storeSubagentResult(services, { runId: childRunId, agentId: input.agentId, conversationId: input.conversationId, text }, cancellation),
    ));
    if (outcome === CANCELLED || !outcome) return CANCELLED;
    deliveredTexts.push(text);
    return 'completed';
  }
  if (isDuplicateDelivery(text, deliveredTexts)) return 'completed';
  // One reply is one bubble, one notification, in every run (a calendar reminder, a chat answer).
  const layout = layoutReply(text);
  if (layout.cardErrors.length > 0) {
    if (retry !== undefined && !retry.used) {
      retry.used = true;
      return { retry: cardRetryHint(layout.cardErrors) };
    }
    services.log?.({ runId, errors: layout.cardErrors }, 'reply card dropped');
  }
  // Never leave the user without a reply: when nothing usable remains, the raw text is the bubble.
  const bubble = layout.bubble ?? { markdown: text.trim() };
  // An unsolicited message (the daily check, a scheduled goal check-in) counts against the owner's daily cap, counted from what was posted: past it the reply is dropped with a log line.
  const counted = countedKind(input.wakeEvents);
  const wake = input.wakeEvents[0];
  if (counted !== undefined && wake !== undefined && !(await ctx.run(`proactive-room:${stepIndex}`, () => hasRoomToPost(services.store, wake.ownerId)))) {
    services.log?.({ runId, ownerId: wake.ownerId, kind: counted }, 'proactive message dropped: daily cap reached');
    return 'silent';
  }
  if ((await postBubble(ctx, services, input, `reply:${stepIndex}`, stepIndex, bubble, cancellation, runId, selectCitations(citations, text))) === CANCELLED) return CANCELLED;
  if (counted !== undefined && wake !== undefined) await ctx.run(`proactive-log:${stepIndex}`, async () => { await logPosted(services.store, { kind: counted, wake, ...(runId === undefined ? {} : { runId }) }); return true; });
  deliveredTexts.push(text);
  return 'completed';
}

/** The longest record line kept on a run row. */
const RECORD_MAX_CHARS = 500;

/**
 * The end of a run that speaks only through send_message (BACKEND §3.3b): its final text is not a message to anyone. It is kept on the run
 * as one line (`record`), which the task list shows as the result; blank text keeps nothing. Journaled, so a replay writes it once.
 */
export async function recordStep(ctx: RunContext, services: RunServices, stepIndex: number, runId: string, text: string): Promise<'completed'> {
  const line = text.replace(/\s+/g, ' ').trim().slice(0, RECORD_MAX_CHARS);
  if (line === '') return 'completed';
  await ctx.run(`record:${stepIndex}`, async () => { await services.store.patch('runs', runId, { record: line }); return true; });
  return 'completed';
}

/**
 * A run that a phone call started: the bridge speaks its streamed text as it arrives, so what the chat keeps must be what was said.
 * Only the explicit channel of the user wake decides it (voice-channel.ts), never an id and never anything the model wrote.
 */
export function isVoiceRun(input: RunInput): boolean {
  return input.wakeEvents.some(isVoiceWake);
}

/**
 * The opening line of a run that goes to work. The text the model wrote with its first tool calls
 * ("Checking flights now") is posted as its own bubble in a direct chat, so the user sees the work
 * start; text between later tool calls stays private (the turn driver silences those previews) and
 * the final reply carries the result. Not in rooms (every agent would announce itself), child runs
 * (silent work items), runs no user message started (a completion wake, a routine), or when the turn
 * already sends a message. The exception is a turn that sends a question card (`asksQuestion`): the card ends the run, so the text
 * written with it is the lead-in and is the only thing said before the card. It is posted in any turn of the run (not only the first),
 * whenever a person is waiting on the run, and even after an earlier opening line. In a voice run every pre-tool line is posted, in any turn
 * (`isVoiceRun`): it was spoken as it streamed, so the chat must keep it.
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
  asksQuestion = false,
): Promise<typeof CANCELLED | 'posted' | 'skipped'> {
  if (isBlankReply(text)) return 'skipped';
  // A voice run speaks every pre-tool line the model streams, so each one is posted too (the rules below only decide what a text chat shows).
  const spoken = isVoiceRun(input);
  if (!asksQuestion && !spoken && (deliveredTexts.length > 0 || toolNames.includes('send_message'))) return 'skipped';
  // The opening line answers the user's own message ("on it"); a run woken by finished background work has nobody waiting to hear it started.
  // A lead-in to a question card is the run's whole reply, so every wake a person waits on (the first hello of onboarding too) has it.
  if (!(asksQuestion ? expectsReply(input) : input.wakeEvents.some((event) => event.kind === 'user_message'))) return 'skipped';
  // Noting something is a quiet act, not work the user waits on: "let me note that down" would narrate memory.
  if (!asksQuestion && !spoken && toolNames.every((name) => QUIET_TOOLS.has(name))) return 'skipped';
  // A tapback is the acknowledgement of quick work, so a turn that reacts, or a run that already did, has no opening line besides it.
  // Longer work (the browser or computer, helpers, several searches in one turn) gets the tapback and one short line on what is being done.
  if (!asksQuestion && !spoken && !isLongWork(toolNames)) {
    if (toolNames.includes('react')) return 'skipped';
    if (runId !== undefined) {
      const reacted = await ctx.run(`ack-reacted:${stepIndex}`, async () => (await services.store.get('runs', runId))?.steps.some((step) => step.tool === 'react' && step.status === 'completed') === true);
      if (reacted) return 'skipped';
    }
  }
  const kind = await ctx.run(`ack-kind:${stepIndex}`, async () => {
    const conversation: unknown = await services.store.get('conversations', input.conversationId);
    const value = typeof conversation === 'object' && conversation !== null ? Reflect.get(conversation, 'kind') : undefined;
    return typeof value === 'string' ? value : '';
  });
  if (kind !== 'direct') return 'skipped';
  if ((await postBubble(ctx, services, input, `ack:${stepIndex}`, stepIndex, { markdown: text }, cancellation, runId, [])) === CANCELLED) return CANCELLED;
  deliveredTexts.push(text);
  return 'posted';
}

/**
 * One agent bubble, in its own durable step and raced against cancel. With a run id the item id is (run, step), so a
 * replay writes the same item; without one it is drawn before the step. `at` is the real post time.
 */
async function postBubble(
  ctx: RunContext,
  services: RunServices,
  input: RunInput,
  key: string,
  stepIndex: number,
  bubble: ReplyBubble,
  cancellation: RunCancellation,
  runId: string | undefined,
  citations: ReplyCitation[],
): Promise<typeof CANCELLED | 'posted'> {
  const id = runId === undefined ? `itm_${ctx.rand.uuidv4()}` : `itm_${runId}_${String(stepIndex)}`;
  const replyTo = replyOriginOf(input.wakeEvents);
  const contextItemIds = [...new Set([
    ...input.wakeEvents.flatMap((event) => event.kind === 'user_message' && event.origin.type === 'user' && typeof event.payload.itemId === 'string'
      ? [event.payload.itemId] : []),
    ...(input.steeredUserItemIds ?? []),
  ])];
  const ui: UiDoc | undefined = bubble.ui;
  const outcome = await cancellation.race((): DurablePromise<ReplyOutcome> => ctx.run(key, async () => {
    if (cancellation.state.cancelled) return { posted: false };
    const item = {
      id,
      conversationId: input.conversationId,
      type: 'agent_message' as const,
      agentId: input.agentId,
      markdown: bubble.markdown,
      citations,
      ...(ui === undefined ? {} : { ui }),
      ...(runId === undefined ? {} : { runId }),
      ...(contextItemIds.length === 0 ? {} : { contextItemIds }),
      ...(replyTo === undefined ? {} : { replyTo }),
      at: new Date().toISOString(),
    };
    const stored = await services.store.put('items', item, { conversationId: input.conversationId, ...(runId === undefined ? {} : { runId }) });
    await emitItemAdded(services.store, input.conversationId, stored);
    return { posted: true };
  }));
  return outcome === CANCELLED || outcome.posted === false ? CANCELLED : 'posted';
}

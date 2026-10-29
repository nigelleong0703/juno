/**
 * Block streaming: the bubbles of a reply are posted while the model is still writing it, each as soon as its
 * paragraph is closed (reply-layout `closedBlocks`), instead of after the whole reply is done.
 *
 * Posting happens inside the durable model-call step, so it must be safe to run twice: every bubble has an id
 * made of (run, step, index) and a repeat overwrites. A replay of a finished step never runs it again. When the
 * turn is over, `reconcileStreamed` compares what was posted with the final layout of the full text (the layout
 * can differ: a heading turns the section into one bubble, a card attaches to its lead-in) and fixes the difference.
 */
import type { Item } from '@agent-desktop/public-contracts';
import { emitItemAdded } from '../../conversation-activity.js';
import { replyOriginOf } from '../../../modules/channel-origin.js';
import type { RunInput, RunServices } from './run-types.js';
import { closedBlocks, MAX_REPLY_BUBBLES, readingPauseMs, type ReplyBubble } from './reply-layout.js';
import type { ReplyCitation } from './final-reply.js';

/** The id of the `index`-th bubble a model step posts for a run; the same on every retry. */
export const streamedItemId = (runId: string, stepIndex: number, index: number): string => `itm_${runId}_${String(stepIndex)}_${String(index)}`;

export interface BlockStreamerDeps {
  now(): number;
  wait(ms: number): Promise<void>;
  post(index: number, markdown: string): Promise<void>;
  /** The owner stopped the run: nothing more is posted. */
  isCancelled(): boolean;
  /** A failed post ends streaming for this turn; the final reply posts whatever is missing. */
  onError?(error: unknown): void;
}

export interface BlockStreamer {
  /** Feed the next piece of the model's visible text. */
  push(delta: string): void;
  /** Stop: a post in flight completes, blocks still waiting for their turn are dropped (the final reply posts them). */
  finish(): Promise<void>;
}

/**
 * Releases closed blocks in order, never two together: a block goes out no earlier than the previous post plus
 * its own reading pause (time the model spent writing counts), at most MAX_REPLY_BUBBLES - 1 of them so the
 * last bubble stays for the rest of the reply.
 */
export function createBlockStreamer(deps: BlockStreamerDeps): BlockStreamer {
  let text = '';
  let queued = 0;
  let lastAt: number | undefined;
  let failed = false;
  let finishing = false;
  let chain: Promise<void> = Promise.resolve();
  let close!: () => void;
  const closing = new Promise<void>((resolve) => { close = resolve; });
  const halted = (): boolean => failed || deps.isCancelled();

  const release = (index: number, block: string): void => {
    chain = chain.then(async () => {
      if (halted()) return;
      if (lastAt !== undefined) {
        const delay = lastAt + readingPauseMs(block) - deps.now();
        // A block that still has to wait when the model is done is left for the final reply, which paces it durably.
        if (delay > 0) {
          // Dropping one drops all after it too: the posted bubbles must stay a run from index 0.
          if (finishing) { failed = true; return; }
          await Promise.race([deps.wait(delay), closing]);
          if (finishing) failed = true;
          if (halted()) return;
        }
      }
      try {
        await deps.post(index, block);
        lastAt = deps.now();
      } catch (error) {
        failed = true;
        deps.onError?.(error);
      }
    });
  };

  return {
    push(delta) {
      if (failed || finishing) return;
      text += delta;
      const blocks = closedBlocks(text);
      for (; queued < Math.min(blocks.length, MAX_REPLY_BUBBLES - 1); queued += 1) release(queued, blocks[queued] ?? '');
    },
    async finish() {
      finishing = true;
      close();
      await chain;
    },
  };
}

/** Write one streamed bubble; a repeat of the same text (a retried step) writes and announces nothing. */
export async function postStreamedBubble(services: RunServices, input: RunInput, runId: string, stepIndex: number, index: number, markdown: string): Promise<void> {
  const id = streamedItemId(runId, stepIndex, index);
  const existing = await services.store.get('items', id);
  if (existing?.type === 'agent_message' && existing.markdown === markdown) return;
  const replyTo = replyOriginOf(input.wakeEvents);
  const item: Item = existing?.type === 'agent_message'
    ? { ...existing, markdown }
    : {
        id,
        conversationId: input.conversationId,
        type: 'agent_message',
        agentId: input.agentId,
        markdown,
        citations: [],
        runId,
        ...(replyTo === undefined ? {} : { replyTo }),
        at: new Date().toISOString(),
      };
  await services.store.put('items', item, { conversationId: input.conversationId, runId });
  await emitItemAdded(services.store, input.conversationId, item);
}

/** What `reconcileStreamed` found: how many of the wanted bubbles already exist, and when the last of them was posted. */
export interface StreamedState { existing: number; lastAt?: number; now: number }

/** How many bubbles of this step are posted (they are a run from index 0), without changing anything. */
export async function countStreamed(services: RunServices, runId: string, stepIndex: number): Promise<number> {
  let count = 0;
  for (; count < MAX_REPLY_BUBBLES; count += 1) {
    const item = await services.store.get('items', streamedItemId(runId, stepIndex, count));
    if (item?.type !== 'agent_message') break;
  }
  return count;
}

const sameUi = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Make the bubbles posted while streaming match the final layout: a posted bubble whose text, card or sources
 * differ is rewritten (the same id announced again: clients replace by id; a platform that already delivered the
 * old text keeps it, which is logged), a posted bubble past the end of the layout is deleted. Safe to run twice.
 */
export async function reconcileStreamed(
  services: RunServices,
  input: RunInput,
  runId: string,
  stepIndex: number,
  bubbles: ReplyBubble[],
  citations: ReplyCitation[],
): Promise<StreamedState> {
  let existing = 0;
  let lastAt: number | undefined;
  for (let index = 0; index < MAX_REPLY_BUBBLES; index += 1) {
    const id = streamedItemId(runId, stepIndex, index);
    const item = await services.store.get('items', id);
    if (item?.type !== 'agent_message') break;
    const wanted = bubbles[index];
    if (wanted === undefined) {
      await services.store.delete('items', id);
      services.log?.({ runId, id }, 'streamed bubble removed: the final layout has fewer bubbles');
      continue;
    }
    existing += 1;
    lastAt = Date.parse(item.at);
    const wantedCitations = index === bubbles.length - 1 ? citations : [];
    if (item.markdown === wanted.markdown && sameUi(item.ui, wanted.ui) && sameUi(item.citations, wantedCitations)) continue;
    const { ui: _ui, ...rest } = item;
    const next: Item = { ...rest, markdown: wanted.markdown, citations: wantedCitations, ...(wanted.ui === undefined ? {} : { ui: wanted.ui }) };
    await services.store.put('items', next, { conversationId: input.conversationId, runId });
    await emitItemAdded(services.store, input.conversationId, next);
    services.log?.({ runId, id }, 'streamed bubble rewritten after the final layout');
  }
  return { existing, ...(lastAt === undefined || Number.isNaN(lastAt) ? {} : { lastAt }), now: Date.now() };
}

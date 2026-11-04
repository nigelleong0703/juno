/**
 * The chat card for the agent's live screen (BACKEND §7.11): the first time a run opens a page in its browser for a person who
 * is waiting in a direct chat, the platform adds one `screen_ref` item, so the person can tap and watch instead of reading a
 * claim that the page is on their screen. Harness-driven (not the model's call), once per run, never per browser call.
 * The card then keeps the latest page and a screenshot of it (`previewLibraryId`), refreshed as the run browses, so the chat shows
 * a picture of the screen: "Live" while the run works, the last frame once it ended.
 */
import type { ToolContext } from '../../../contracts/index.js';
import { emitItemAdded } from '../../../execution/conversation-activity.js';
import { shouldAddFeedCard } from '../../feed/feedCard.js';
import { nowIso } from '../util.js';
import type { ComputerClientProvider } from './client.js';
import { saveScreenPreview } from './preview.js';

type Page = { url: string; title?: string };
type On = 'sandbox' | 'mac' | undefined;
/** At most one screenshot per card in this window; the last page of a burst is still captured once the window ends. */
const REFRESH_MIN_MS = 6_000;
const SHOT_TIMEOUT_MS = 10_000;
const lastRefresh = new Map<string, number>();
const trailing = new Map<string, NodeJS.Timeout>();

/** Add the run's screen card when it is due; best effort, a failure here never fails the browser call. */
export async function addScreenCard(ctx: ToolContext, page: Page, on: On): Promise<void> {
  // The Mac has its own control surface; this card is for the agent's own sandbox screen.
  if (on === 'mac') return;
  try {
    const id = `scr-${ctx.runId}`;
    if (await ctx.store.get('items', id) !== null) return;
    const conversation = await ctx.store.get('conversations', ctx.conversationId);
    if (conversation?.kind !== 'direct') return;
    if (!(await shouldAddFeedCard(ctx.store, ctx))) return;
    const item = {
      id,
      conversationId: ctx.conversationId,
      type: 'screen_ref' as const,
      agentId: ctx.agentId,
      runId: ctx.runId,
      url: page.url,
      ...(page.title ? { title: page.title } : {}),
      at: nowIso(),
    };
    await ctx.store.put('items', item, { conversationId: ctx.conversationId, runId: ctx.runId });
    await emitItemAdded(ctx.store, ctx.conversationId, item);
  } catch {
    // The card is a convenience; the page itself was opened.
  }
}

/** Keep the run's card on the page and screenshot it is now at; fire and forget, throttled, and a run without a card does nothing. */
export function refreshScreenCard(provider: ComputerClientProvider | undefined, ctx: ToolContext, page: Page, on: On): void {
  if (on === 'mac') return;
  const id = `scr-${ctx.runId}`;
  const wait = REFRESH_MIN_MS - (Date.now() - (lastRefresh.get(id) ?? 0));
  if (wait > 0) {
    clearTimeout(trailing.get(id));
    const timer = setTimeout(() => { trailing.delete(id); refreshScreenCard(provider, ctx, page, on); }, wait);
    timer.unref();
    trailing.set(id, timer);
    return;
  }
  lastRefresh.set(id, Date.now());
  if (lastRefresh.size > 200) lastRefresh.delete(lastRefresh.keys().next().value as string);
  void updateScreenCard(provider, ctx, id, page, on).catch(() => undefined);
}

async function updateScreenCard(provider: ComputerClientProvider | undefined, ctx: ToolContext, id: string, page: Page, on: On): Promise<void> {
  const card = await ctx.store.get('items', id);
  if (card?.type !== 'screen_ref') return;
  const preview = await saveScreenPreview(provider, { ...ctx, signal: AbortSignal.timeout(SHOT_TIMEOUT_MS) }, on, 'screen');
  const item = {
    ...card,
    url: page.url,
    ...(page.title ? { title: page.title } : {}),
    ...(preview === undefined ? {} : { previewLibraryId: preview.libraryId }),
  };
  await ctx.store.put('items', item, { conversationId: ctx.conversationId, runId: ctx.runId });
  await emitItemAdded(ctx.store, ctx.conversationId, item);
  // The frame it replaces is named by nothing now (its image bytes are content-addressed and stay).
  if (card.previewLibraryId !== undefined && preview !== undefined) await ctx.store.forOwner?.(ctx.ownerId).delete('library', card.previewLibraryId);
}

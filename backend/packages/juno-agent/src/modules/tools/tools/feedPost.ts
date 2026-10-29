// feed_post: the agent's side of the owner's `feedPosts` collection. Owner and agent come from the ToolContext,
// never from arguments. A post is information for the owner's feed; it asks for nothing.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { parseUiDoc, type FeedPost, type UiDoc } from '@agent-desktop/public-contracts';
import { newId, nowIso } from '../util.js';
import { emitItemAdded } from '../../../execution/conversation-activity.js';
import { FEED_DEDUPE_DAYS, normalizeUrl, recentRoutinePosts } from '../../feed/context.js';
import { shouldAddFeedCard } from '../../feed/feedCard.js';
import type { SafeFetchDeps } from '../net/safeFetch.js';
import { containsHtmlImage, extractMarkdownImageRefs } from '../../feed/articleImages.js';
import { httpsUrl, verifyFeedImage, type FeedImageShape, type SeenImages, type VerifiedImage } from '../../feed/feedImage.js';

const feedPostInputSchema = z.object({
  title: z.string().trim().min(1).max(80, 'keep the title to one short line (80 characters)'),
  summary: z.string().trim().min(1, 'summary is required: one or two plain sentences').max(240, 'keep the summary to two sentences (240 characters); move details to body or ui'),
  body: z.string().trim().min(1).max(6000, 'body is over 6000 characters: cut it down').optional(),
  ui: z.unknown().optional(),
  imageUrl: z.string().trim().min(1).optional(),
  imageCaption: z.string().trim().min(1).max(120, 'keep the image caption to one line (120 characters)').optional(),
  sourceUrl: z.string().trim().min(1).optional(),
});

function imageAdvice(reason: string): string {
  if (reason === 'download failed') return 'it could not be downloaded (unavailable or private)';
  if (reason === 'not https') return 'it is not an https URL';
  if (reason === 'redirected off https') return 'it redirects away from https';
  if (reason === 'not a raster image') return 'it is not a real picture file';
  if (reason === 'too small') return 'it is too small to show';
  if (reason === 'odd aspect ratio') return 'its shape cannot be shown';
  if (reason === 'looks like a logo or placeholder') return 'it looks like a logo or placeholder';
  return 'it was already used by this routine';
}

function result(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: isError ? 'Error: ' + text : text }], ...(isError ? { isError } : {}) };
}

export function createFeedPostTool(opts: { deps?: SafeFetchDeps } = {}): Tool {
  return {
    name: 'feed_post',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '' },
        summary: { type: 'string', description: 'One or two plain sentences (max 240 characters): what the card shows.' },
        body: { type: 'string', description: '' },
        ui: { type: 'object', description: '' },
        imageUrl: { type: 'string', description: '' },
        imageCaption: { type: 'string', description: '' },
        sourceUrl: { type: 'string', description: '' },
      },
      required: ['title', 'summary'],
    },
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = feedPostInputSchema.safeParse(args);
      if (!parsed.success) return invalidArguments('feed_post', args, parsed.error);
      if (ctx.ownerId.length === 0 || ctx.agentId.length === 0) return result('no owner or agent context, so the feed is unavailable.', true);
      const { title, summary, body, sourceUrl } = parsed.data;
      let ui: UiDoc | undefined;
      if (parsed.data.ui !== undefined) {
        const doc = parseUiDoc(parsed.data.ui, 'message');
        if (!doc.ok) return result('invalid ui: ' + doc.error + ' (a feed post takes display blocks only)', true);
        ui = doc.doc;
      }
      // A scheduled routine run publishes for that routine (the post carries its id).
      const routineId = ctx.wake.kind === 'routine' && typeof ctx.wake.payload['routineId'] === 'string' ? ctx.wake.payload['routineId'] : undefined;
      if (parsed.data.imageUrl !== undefined && httpsUrl(parsed.data.imageUrl) === undefined) return result('imageUrl must be an https URL.', true);
      if (parsed.data.imageUrl !== undefined && parsed.data.imageCaption === undefined) return result('imageCaption is required with imageUrl: look at the image (web_fetch on its URL) and say in one line what it shows, or leave the image out.', true);
      // The picture is only ever the one the agent chose; it must pass verifyFeedImage or the post has none.
      const recent = routineId === undefined ? [] : await recentRoutinePosts(ctx.store, ctx.ownerId, routineId, new Date());
      const seen: SeenImages = {
        urls: new Set(recent.flatMap((post) => (post.imageUrl === undefined ? [] : [normalizeUrl(post.imageUrl)]))),
        hashes: new Set(recent.flatMap((post) => { const hash = (post as { imageSha256?: string }).imageSha256; return hash === undefined ? [] : [hash]; })),
      };
      const check = { ...(opts.deps === undefined ? {} : { deps: opts.deps }), signal: ctx.signal, seen, normalize: normalizeUrl };
      // Every URL is downloaded once: the cover and the body share verdicts by normalized URL.
      const verdicts = new Map<string, VerifiedImage>();
      const verifyOnce = async (url: string, shape: FeedImageShape): Promise<VerifiedImage> => {
        const known = verdicts.get(url);
        if (known !== undefined) return known;
        const verdict = await verifyFeedImage(url, { ...check, shape });
        verdicts.set(url, verdict);
        return verdict;
      };
      let image: { url: string; sha256: string } | undefined;
      let dropped = '';
      if (parsed.data.imageUrl !== undefined) {
        const cover = httpsUrl(parsed.data.imageUrl) ?? parsed.data.imageUrl;
        const verdict = await verifyOnce(cover, 'cover');
        if (verdict.ok) image = { url: verdict.url, sha256: verdict.sha256 };
        else dropped = ' The image was not attached (' + verdict.reason + ').';
      }
      // Every rendered inline picture is verified BEFORE anything is published: one bad body image
      // refuses the whole post (nothing stored, no card, no event) with an actionable reason.
      if (parsed.data.body !== undefined) {
        if (containsHtmlImage(parsed.data.body)) {
          return result('The body uses an HTML <img> tag, which the Feed neither renders nor verifies: rewrite it as a Markdown image or drop it; nothing was published.', true);
        }
        for (const ref of extractMarkdownImageRefs(parsed.data.body)) {
          if (ctx.signal.aborted) return result('The run was stopped before the article images could be verified; nothing was published.', true);
          const inline = httpsUrl(ref.url);
          if (inline === undefined) return result('Body image ' + ref.url + ' is not a full https URL: use a complete https address or drop the picture; nothing was published.', true);
          const verdict = await verifyOnce(inline, 'article');
          if (!verdict.ok) return result('Body image ' + inline + ' was not published because ' + imageAdvice(verdict.reason) + ': check the URL with web_fetch, replace it with a picture that loads, or drop that picture; nothing was published.', true);
        }
      }
      const imageUrl = image?.url;
      // One durable step: a replay returns the recorded outcome instead of publishing a second post.
      return ctx.step('feed_post', async (): Promise<ToolResult> => {
        if (sourceUrl !== undefined) {
          const wanted = normalizeUrl(sourceUrl);
          const twin = recent.find((post) => post.sourceUrl !== undefined && normalizeUrl(post.sourceUrl) === wanted);
          if (twin !== undefined) return result('Not published: this link was already posted by this routine in the last ' + String(FEED_DEDUPE_DAYS) + ' days ("' + twin.title + '"). Pick a different story or post nothing.', true);
        }
        const now = nowIso();
        const post: FeedPost & { ownerId: string; imageSha256?: string | undefined } = {
          id: 'feed-' + String(Date.now()) + '-' + randomUUID().slice(0, 8),
          ownerId: ctx.ownerId,
          agentId: ctx.agentId,
          title,
          summary,
          ...(body === undefined ? {} : { body }),
          ...(ui === undefined ? {} : { ui }),
          ...(imageUrl === undefined ? {} : { imageUrl, imageCaption: parsed.data.imageCaption, imageSha256: image?.sha256 }),
          ...(sourceUrl === undefined ? {} : { sourceUrl }),
          ...(routineId === undefined ? {} : { routineId }),
          liked: false,
          createdAt: now,
          updatedAt: now,
        };
        const created = await ctx.store.put('feedPosts', post);
        await ctx.store.emit({ type: 'feed.created', post: created });
        // Only a run the user started from this chat gets a card there: a direct
        // user message, or a task_done parent publishing after its user-requested
        // notify child completed (canonical run/notify links, never the payload
        // alone). Routines, goals, proactive and actual child runs stay feed-only.
        const fromChat = await shouldAddFeedCard(ctx.store, ctx);
        if (!fromChat) return result('Published to the feed: ' + title + '.' + dropped + ' Nothing was added to the chat; do not repeat the post there.');
        const item = {
          id: newId('itm'),
          conversationId: ctx.conversationId,
          type: 'feed_ref' as const,
          agentId: ctx.agentId,
          runId: ctx.runId,
          feedPostId: created.id,
          title,
          summary,
          ...(imageUrl === undefined ? {} : { imageUrl }),
          at: nowIso(),
        };
        await ctx.store.put('items', item, { conversationId: ctx.conversationId, runId: ctx.runId });
        await emitItemAdded(ctx.store, ctx.conversationId, item);
        return result('Published to the feed: ' + title + '.' + dropped + ' A card linking to it was added to this chat; do not write the post into the chat again.');
      });
    },
  };
}

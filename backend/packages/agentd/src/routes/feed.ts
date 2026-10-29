import { type Context, type Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { FeedPost } from '@agent-desktop/public-contracts';
import { feedbackInputSchema, likeFeedPostInputSchema } from '@agent-desktop/public-contracts';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { docOwnerId, listAll, paginateFiltered } from './relationships.js';

/** Old rows kept the card text in `body`: a short one becomes the summary, a long one stays the body with a clipped summary. */
export function readFeedPost(stored: FeedPost): FeedPost {
  // `imageSha256` is server bookkeeping for the image duplicate check, not part of the contract.
  const { imageSha256: _hash, ...row } = stored as FeedPost & { imageSha256?: string };
  if (row.summary !== undefined) return row;
  const old = (row as { body?: string }).body ?? '';
  if (old.length <= 240) return { ...row, summary: old || row.title, body: undefined } as FeedPost;
  return { ...row, summary: old.slice(0, 239).trimEnd() + '…' };
}

/** The caller's own post, or undefined: another owner's post answers exactly like a missing one. */
async function ownRow(deps: AgentdDeps, c: Context): Promise<FeedPost | undefined> {
  const row = await deps.store.get('feedPosts', c.req.param('id') ?? '');
  return row !== null && docOwnerId(row) === getOwnerId(c) ? row : undefined;
}

/** The owner's feed: posts agents published (from routines or on their own), newest first, with likes and feedback. Every route stays inside the caller's rows. */
export function registerFeed(app: Hono, deps: AgentdDeps) {
  app.get('/v1/feed', async (c) => {
    const ownerId = getOwnerId(c);
    const query = c.req.query();
    const loaded = await listAll(deps.store, 'feedPosts');
    if (loaded.truncated) {
      return c.json({ error: { code: 'LIST_TRUNCATED', message: 'Feed list truncated; retry later' } }, 500);
    }
    const own = loaded.items
      .filter((row) => docOwnerId(row) === ownerId)
      .filter((row) => query['agentId'] === undefined || row.agentId === query['agentId'])
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    const page = paginateFiltered(own, query['limit'], query['cursor']);
    return c.json({ items: page.items.map(readFeedPost), nextCursor: page.nextCursor ?? null });
  });

  app.post('/v1/feed/:id/like', zValidator('json', likeFeedPostInputSchema), async (c) => {
    const row = await ownRow(deps, c);
    if (row === undefined) return c.json({ error: { code: 'FEED_POST_NOT_FOUND', message: 'Feed post not found' } }, 404);
    const updated = await deps.store.patch('feedPosts', row.id, { liked: c.req.valid('json').liked, updatedAt: new Date().toISOString() });
    const post = readFeedPost(updated);
    await deps.store.emit({ type: 'feed.updated', post });
    return c.json(post);
  });

  app.post('/v1/feed/:id/feedback', zValidator('json', feedbackInputSchema), async (c) => {
    const row = await ownRow(deps, c);
    if (row === undefined) return c.json({ error: { code: 'FEED_POST_NOT_FOUND', message: 'Feed post not found' } }, 404);
    const { signal, reason, note } = c.req.valid('json');
    // Each feedback replaces the last whole: an absent reason or note clears the earlier one.
    const updated = await deps.store.patch('feedPosts', row.id, { feedback: signal, feedbackReason: reason, feedbackNote: note === undefined || note === '' ? undefined : note, updatedAt: new Date().toISOString() });
    const post = readFeedPost(updated);
    await deps.store.emit({ type: 'feed.updated', post });
    return c.json(post);
  });
}

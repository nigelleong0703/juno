/**
 * After a routine run finished: announce the Feed posts it made (`feed.brief`: clients refetch the Feed, and it is the
 * push trigger unless the routine's notify is `never`). Posts carry the routine's id (stamped by `feed_post`).
 */
import type { Routine } from '@agent-desktop/public-contracts';
import type { Store } from '../../contracts/index.js';
import { docOwner } from '../../execution/execution-owner.js';
import { listAll } from '../memory/util.js';

export async function announceRoutinePosts(store: Store, routine: Routine, startedAt: string): Promise<void> {
  const ownerId = docOwner(routine);
  const posts = (await listAll(store, 'feedPosts', { where: { agentId: routine.agentId } }))
    .filter((post) => post.routineId === routine.id && post.createdAt >= startedAt && (ownerId === undefined || docOwner(post) === ownerId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (posts.length === 0) return;
  await store.emit({ type: 'feed.brief', routineId: routine.id, title: routine.name, postIds: posts.map((post) => post.id), firstPostTitle: posts[0]?.title ?? routine.name, notify: routine.notify.mode !== 'never' });
}

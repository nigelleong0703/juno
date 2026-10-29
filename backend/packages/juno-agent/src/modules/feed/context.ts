/**
 * What an agent knows about the owner's Feed when it wakes (BACKEND §10.10): the owner's local clock, the posts this
 * routine made lately (so it does not repeat itself) and the owner's feedback on the agent's posts. Pure reads and
 * fixed wording; nothing here knows about Restate, routines' timers or the tools.
 */
import type { FeedPost } from '@agent-desktop/public-contracts';
import type { Store } from '../../contracts/index.js';
import { docOwner } from '../../execution/execution-owner.js';
import { readOwnerTimeZone } from '../../execution/brain/context.js';
import { listAll } from '../memory/util.js';

export const FEED_DEDUPE_DAYS = 7;
export const FEEDBACK_NOTES = 20;
const DAY_MS = 86_400_000;

const REASON_ADVICE: Record<string, string> = {
  topic: 'topic: avoid that topic',
  frequency: 'too often: post less often, or only when it matters',
  known: 'already knew: prefer newer or less obvious items',
  source: 'bad source: avoid that source or domain',
  more: 'more like this: find more like it',
};

export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

function hostOf(url: string | undefined): string {
  try { return url === undefined ? 'unknown' : new URL(url).hostname; } catch { return 'unknown'; }
}

/** One post's feedback in plain words, e.g. "Less (too often): <title>". Static wording plus the post's data. */
export function feedbackLine(post: FeedPost): string {
  const title = oneLine(post.title);
  if (post.feedback === 'more') return `More like this: ${title}`;
  switch (post.feedbackReason) {
    case 'topic': return `Less like this (topic): ${title}`;
    case 'frequency': return `Less (too often): ${title}`;
    case 'known': return `Less (already knew): ${title}`;
    case 'source': return `Less (bad source: ${hostOf(post.sourceUrl)}): ${title}`;
    case 'other': return `Less (other${post.feedbackNote === undefined ? '' : ': ' + oneLine(post.feedbackNote)}): ${title}`;
    default: return `Less like this: ${title}`;
  }
}

/** One static line on how to act, naming only the kinds of feedback present. */
export function feedbackAdvice(posts: FeedPost[]): string {
  const keys = new Set<string>(posts.map((post) => (post.feedback === 'more' ? 'more' : post.feedbackReason ?? '')));
  const parts = Object.entries(REASON_ADVICE).filter(([key]) => keys.has(key)).map(([, text]) => text);
  return parts.length === 0 ? '' : 'How to act on it: ' + parts.join('; ') + '.';
}

/** The zone an owner's local times are shown in: their reported timezone, UTC when unset. */
export async function ownerTimeZone(store: Store, ownerId: string): Promise<string> {
  return (await readOwnerTimeZone(store, ownerId)) ?? 'UTC';
}

/** "Friday, October 16, 2026 at 07:30 (Asia/Singapore)" for `now` in `tz`. */
export function localLabel(now: Date, tz: string): string {
  return `${new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now)} (${tz})`;
}

/** Same page, ignoring scheme-less noise: host case, a trailing slash and the fragment. */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '';
    return url.protocol + '//' + url.host.toLowerCase() + path + url.search;
  } catch {
    return raw.trim();
  }
}

type OwnedPost = FeedPost & { ownerId?: string };

async function ownerPosts(store: Store, ownerId: string, agentId?: string): Promise<OwnedPost[]> {
  const all = await listAll(store, 'feedPosts', agentId === undefined ? {} : { where: { agentId } });
  return all.filter((post) => docOwner(post) === ownerId);
}

/** The posts one routine's runs made in the last `days` days, newest first. */
export async function recentRoutinePosts(store: Store, ownerId: string, routineId: string, now: Date, days = FEED_DEDUPE_DAYS): Promise<FeedPost[]> {
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();
  return (await ownerPosts(store, ownerId)).filter((post) => post.routineId === routineId && post.createdAt >= since).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The owner's latest feedback on this agent's posts, newest first, at most `FEEDBACK_NOTES`. */
export async function recentFeedback(store: Store, ownerId: string, agentId: string): Promise<FeedPost[]> {
  return (await ownerPosts(store, ownerId, agentId)).filter((post) => post.feedback !== undefined).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, FEEDBACK_NOTES);
}

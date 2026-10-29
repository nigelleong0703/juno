/**
 * `GET /v1/today`: the Chat tab header, composed from pending requests, running runs and today's routine posts (the fields the clients
 * read today), and from what the owner should look at and what is moving (BACKEND §10.17): the needs-you list across the requests, the
 * memory items to review and the possible account matches; today's runs and the goals with progress; the latest feed posts; the open ideas.
 */
import { type Hono } from 'hono';
import type { Today, TodayNeedsYouItem } from '@agent-desktop/public-contracts';
import type { MemoryItem } from '@agent-desktop/memory-graph/memory';
import { MemoryUnavailableError } from '@agent-desktop/memoryd/contract';
import type { PossibleMatch } from 'juno-agent/modules/memory/owner-edits';
import type { MemoryPort } from 'juno-agent/modules/memory/port';
import { listAll as listWhere } from 'juno-agent/modules/memory/util';
import { ownerTimeZone } from 'juno-agent/modules/feed/context';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { docOwnerId, listAll } from './relationships.js';
import { composeInspiration, userStateOf } from './inspiration.js';

const COMPLETED_WINDOW_MS = 24 * 60 * 60 * 1000;
const COMPLETED_MAX = 3;
const NEEDS_YOU_MAX = 10;
const GOALS_MAX = 5;
const FEED_MAX = 5;
const IDEAS_MAX = 3;
/** Steps that are not work the owner waits on: finding a tool, noting a memory, a reaction. */
const NOT_WORK = new Set(['tool_search', 'tool_load', 'memory_note', 'react']);
/** A run is progress only when it did something; a plain reply is already in the chat. */
const didWork = (steps: readonly { target: string }[]): boolean => steps.some((step) => !NOT_WORK.has(step.target));

/** The owner's local calendar date and hour for `now`. */
function localParts(now: Date, timezone: string): { localDate: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { localDate: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')) };
}

const localDateOf = (iso: string, timezone: string): string => localParts(new Date(iso), timezone).localDate;

/**
 * The memory lines of "needs you": the items waiting for review and the possible account matches. Today is the header of the Chat tab,
 * so when memoryd cannot answer these two lists are left out (empty) rather than failing the whole header.
 */
async function memoryNeeds(memory: MemoryPort | undefined, ownerId: string): Promise<{ reviews: MemoryItem[]; matches: PossibleMatch[] }> {
  if (memory === undefined) return { reviews: [], matches: [] };
  try {
    const [reviews, matches] = await Promise.all([memory.owner.items(ownerId, { status: 'needs_review' }), memory.owner.possibleMatches(ownerId)]);
    return { reviews, matches };
  } catch (error) {
    if (error instanceof MemoryUnavailableError) return { reviews: [], matches: [] };
    throw error;
  }
}

export function registerToday(app: Hono, deps: AgentdDeps) {
  app.get('/v1/today', async (c) => {
    const ownerId = getOwnerId(c);
    const timezone = await ownerTimeZone(deps.store, ownerId);
    const { localDate, hour } = localParts(new Date(), timezone);
    const pending = (await listWhere(deps.store, 'requests', { where: { status: 'pending' } })).filter((row) => docOwnerId(row) === ownerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const running = (await listWhere(deps.store, 'runs', { where: { status: 'running' } }))
      .filter((run) => docOwnerId(run) === ownerId && run.parentRunId === undefined && run.kind !== 'background')
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    // The owner's feed posts: the ones routine runs made make the brief (only today's, local day); the newest few make the feed.
    const ownPosts = (await listAll(deps.store, 'feedPosts')).items.filter((post) => docOwnerId(post) === ownerId);
    const posts = ownPosts.filter((post) => post.routineId !== undefined && localDateOf(post.createdAt, timezone) === localDate)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const first = posts[0];
    const now = new Date();
    // Finished in the last day and not seen: no `seenAt`, and the chat was not read since (opening the chat is the read marker). Routine runs are not listed: nobody waits on them, what they have to say is in the Feed or the chat. Nor are runs that did no work (didWork).
    const finished = (await listWhere(deps.store, 'runs', { where: { status: 'completed' } }))
      .filter((run) => docOwnerId(run) === ownerId && run.parentRunId === undefined && run.kind !== 'background' && run.seenAt === undefined
        && run.finishedAt !== undefined && now.getTime() - Date.parse(run.finishedAt) <= COMPLETED_WINDOW_MS && run.routineId === undefined && didWork(run.steps))
      .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
    const completed: Today['completed'] = [];
    for (const run of finished) {
      const conversation = run.conversationId === undefined ? null : await deps.store.get('conversations', run.conversationId);
      if (conversation?.lastReadAt !== undefined && conversation.lastReadAt >= (run.finishedAt ?? '')) continue;
      completed.push({ runId: run.id, agentId: run.agentId, title: run.title, finishedAt: run.finishedAt ?? '' });
      if (completed.length === COMPLETED_MAX) break;
    }
    const agents = (await listAll(deps.store, 'agents')).items.filter((agent) => docOwnerId(agent) === ownerId);
    const userState = await userStateOf(deps.store, ownerId, agents.length);
    const inspiration = await composeInspiration(deps, ownerId, userState, now, agents);
    const { reviews, matches } = await memoryNeeds(deps.memory, ownerId);
    const needs: TodayNeedsYouItem[] = [
      ...pending.map((request): TodayNeedsYouItem => ({ kind: 'request', requestId: request.id, agentId: request.agentId, title: request.title })),
      ...reviews.map((item): TodayNeedsYouItem => ({ kind: 'memory_review', itemId: item.id, text: item.text })),
      ...matches.map((match): TodayNeedsYouItem => ({
        kind: 'possible_match',
        accountId: match.account.id,
        accountName: match.account.name ?? match.account.externalId,
        personId: match.person.id,
        personName: match.person.name,
      })),
    ];
    const working = running.map((run) => ({ agentId: run.agentId, runId: run.id, title: run.title }));
    const runsToday = (await listAll(deps.store, 'runs')).items.filter((run) => docOwnerId(run) === ownerId && run.parentRunId === undefined
      && run.kind !== 'background' && localDateOf(run.startedAt, timezone) === localDate).length;
    const goals = (await listAll(deps.store, 'goals')).items
      .filter((goal) => docOwnerId(goal) === ownerId && goal.status === 'active')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      .slice(0, GOALS_MAX)
      .map((goal) => ({ goalId: goal.id, agentId: goal.agentId, title: goal.title, done: (goal.steps ?? []).filter((step) => step.done).length, total: (goal.steps ?? []).length }));
    const feed = [...ownPosts].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(0, FEED_MAX)
      .map((post) => ({
        id: post.id,
        agentId: post.agentId,
        title: post.title,
        summary: post.summary,
        ...(post.imageUrl === undefined ? {} : { imageUrl: post.imageUrl }),
        createdAt: post.createdAt,
        liked: post.liked,
      }));
    const ideas = (await listAll(deps.store, 'ideas')).items
      .filter((idea) => docOwnerId(idea) === ownerId && idea.status === 'open')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .slice(0, IDEAS_MAX);
    const today: Today = {
      userState, completed, inspiration,
      now: { hour, localDate, timezone },
      needsYou: {
        count: pending.length,
        top: pending.slice(0, 2).map((request) => ({ requestId: request.id, agentId: request.agentId, title: request.title })),
        total: needs.length,
        items: needs.slice(0, NEEDS_YOU_MAX),
      },
      working,
      progress: { runsToday, working, goals },
      feed,
      ideas,
      ...(first?.routineId === undefined ? {} : {
        brief: {
          routineId: first.routineId,
          postIds: posts.slice(0, 20).map((post) => post.id),
          summary: posts.length === 1 ? first.title : `${first.title} · ${String(posts.length - 1)} more`,
          at: first.createdAt,
        },
      }),
    };
    return c.json(today);
  });
}

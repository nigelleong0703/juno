/**
 * What the agents learned about the user (BACKEND §5.5): the claims behind the lines of MEMORY.md, search over the owner's memory items,
 * and forgetting. The lines themselves are edited through /v1/home. Every route stays inside the caller's own rows. The app sees the
 * owner's whole memory (no agent is asked for, so no agent's private items are left out here either: the app is the owner).
 */
import { type Context, type Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  forgetMemoryInputSchema, memoryClaimStatusSchema, memoryItemStatusSchema, memoryItemTopicSchema, reviewMemoryItemInputSchema, updateMemoryItemInputSchema,
  type MemoryClaim, type MemoryItemStatus, type MemoryItemTopic, type MemoryTopicView,
} from '@agent-desktop/public-contracts';
import { jobAgent } from 'juno-agent/modules/memory/jobs/agent';
import type { MemoryPort } from 'juno-agent/modules/memory/port';
import { listAll } from 'juno-agent/modules/memory/util';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { paginateFiltered } from './relationships.js';
import { memoryItemViewsOf, owned } from './owner-shared.js';

const SEARCH_HITS = 20;
const claimsQuery = z.object({ status: memoryClaimStatusSchema.optional() });
const searchQuery = z.object({ q: z.string().trim().min(1) });
const itemsQuery = z.object({ about: z.string().min(1).optional(), status: memoryItemStatusSchema.optional(), topic: memoryItemTopicSchema.optional() });

/** The section titles of the Memory page, in the app's language (English), like the other labels of the memory views. */
const TOPIC_LABELS: Readonly<Record<MemoryItemTopic, string>> = {
  identity: 'About you', health: 'Health', work: 'Work', plans: 'Plans', preferences: 'Preferences', people: 'People', agents: 'Your agents', home: 'Home', other: 'Other',
};

/**
 * One page of the owner's items, newest first. Without a status the retracted items (taken out of the views) stay out of the list.
 * The cursor and limit are the usual ones (`paginateFiltered`).
 */
async function itemPage(c: Context, deps: AgentdDeps, memory: MemoryPort, filter: { aboutPersonId?: string; status?: MemoryItemStatus; topic?: MemoryItemTopic }): Promise<Response> {
  const ownerId = getOwnerId(c);
  const visible = (await memory.owner.items(ownerId, filter))
    .filter((item) => filter.status !== undefined || item.status !== 'retracted')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const page = paginateFiltered(visible, c.req.query('limit'), c.req.query('cursor'));
  return c.json({ items: await memoryItemViewsOf(deps, memory, ownerId, page.items), nextCursor: page.nextCursor ?? null });
}

export function registerMemory(app: Hono, deps: AgentdDeps) {
  app.get('/v1/memory/claims', zValidator('query', claimsQuery), async (c) => {
    const ownerId = getOwnerId(c);
    const { status } = c.req.valid('query');
    const claims = (await listAll(deps.store, 'memoryClaims'))
      .filter((claim) => claim.ownerId === ownerId && (status === undefined || claim.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .map(({ ownerId: _owner, ...claim }): MemoryClaim => claim);
    return c.json({ claims });
  });

  app.post('/v1/memory/forget', zValidator('json', forgetMemoryInputSchema), async (c) => {
    const ownerId = getOwnerId(c);
    const memory = deps.memory;
    if (memory === undefined) return c.json({ error: { code: 'MEMORY_UNAVAILABLE', message: 'Memory items need the database; this deployment has none' } }, 503);
    const target = await jobAgent(deps.store, ownerId);
    return c.json(await memory.forget({ ownerId, agentId: target?.agent.id ?? '', claimIds: c.req.valid('json').claimIds }));
  });

  app.get('/v1/memory/search', zValidator('query', searchQuery), async (c) => {
    const ownerId = getOwnerId(c);
    const memory = deps.memory;
    if (memory === undefined) return c.json({ error: { code: 'MEMORY_UNAVAILABLE', message: 'Memory items need the database; this deployment has none' } }, 503);
    const hits = await memory.search({ ownerId, presence: { kind: 'owner' }, agentId: undefined, query: c.req.valid('query').q, limit: SEARCH_HITS });
    return c.json({ hits: hits.map(({ item, score }) => ({ id: item.id, text: item.text, file: item.file, score })) });
  });

  // The Memory segment (BACKEND §10.17): the items with their labels, the owner's edits of an item, and the review queue.
  app.get('/v1/memory/items', zValidator('query', itemsQuery), (c) => owned(c, deps, (memory) => {
    const { about, status, topic } = c.req.valid('query');
    return itemPage(c, deps, memory, { aboutPersonId: about, status, topic });
  }));

  // The sections of the Memory page: the topics that have items, each with its second-person summary and its count.
  app.get('/v1/memory/topics', (c) => owned(c, deps, async (memory) => {
    const topics = await memory.owner.topics(getOwnerId(c));
    return c.json({ items: topics.map((entry): MemoryTopicView => ({ ...entry, label: TOPIC_LABELS[entry.topic] })) });
  }));

  app.patch('/v1/memory/items/:id', zValidator('json', updateMemoryItemInputSchema), (c) => owned(c, deps, async (memory) => {
    const ownerId = getOwnerId(c);
    const body = c.req.valid('json');
    const item = await memory.owner.updateItem(ownerId, c.req.param('id'), { text: body.text, audience: body.audience, sensitive: body.sensitive });
    return c.json((await memoryItemViewsOf(deps, memory, ownerId, [item]))[0]);
  }));

  app.delete('/v1/memory/items/:id', (c) => owned(c, deps, async (memory) => {
    await memory.owner.deleteItem(getOwnerId(c), c.req.param('id'));
    return c.json({});
  }));

  app.get('/v1/memory/review', (c) => owned(c, deps, (memory) => itemPage(c, deps, memory, { status: 'needs_review' })));

  app.post('/v1/memory/review/:id', zValidator('json', reviewMemoryItemInputSchema), (c) => owned(c, deps, async (memory) => {
    const ownerId = getOwnerId(c);
    const id = c.req.param('id');
    const review = c.req.valid('json');
    if (review.action === 'delete') {
      await memory.owner.deleteItem(ownerId, id);
      return c.json({});
    }
    // Keep: the item is shown again (active), and the person it is about may be named now.
    const item = await memory.owner.updateItem(ownerId, id, { status: 'active', aboutPersonId: review.about });
    return c.json((await memoryItemViewsOf(deps, memory, ownerId, [item]))[0]);
  }));
}

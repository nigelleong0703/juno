// Shared fixtures for the PH6 resource suites. Kept outside the *.test.ts glob so the pinned entry
// (agent-resources.test.ts) can compose the suites without registering the same tests twice.
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { z } from 'zod';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { Collection, Doc, ListPage, ListQuery, Store, ToolContext, WakeEvent } from '../../../contracts/index.js';
import type { Agent, Conversation } from '@agent-desktop/public-contracts';
import type { SkillsService } from '@agent-desktop/memory-graph/skills';
import { createFakeSkills, type FakeSkill } from '../../../testing/skills.js';
import { buildContext } from '../context.js';
import { contextText } from './context-text.js';

export const NOW = '2026-10-08T00:00:00.000Z';
export const AGENT = 'agent-alpha';
export const PEER = 'agent-beta';

export const errorBodySchema = z.object({ error: z.object({ code: z.string() }) });

export function agentDoc(id: string, skillIds: string[]): Agent {
  return {
    id,
    name: 'Agent ' + id,
    handle: id,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'Test agent',
    status: 'idle',
    section: 'Agents',
    pinned: false,
    lastActivity: NOW,
    unreadCount: 0,
    channels: [],
    macAccess: false,
    skillIds,
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** The skills the fixture owner has; the selections above name them by id. */
export const FIXTURE_SKILLS: FakeSkill[] = [
  { id: 'skl-alpha', name: 'Alpha Skill', description: 'Alpha procedures.', instructions: 'ALPHA-INSTRUCTIONS-FULL', ownerId: 'owner-1' },
  { id: 'skl-beta', name: 'Beta Skill', description: 'Beta procedures.', instructions: 'BETA-INSTRUCTIONS-FULL', ownerId: 'owner-1' },
];

export function conversationDoc(id: string, agentIds: string[]): Conversation {
  return { id, kind: 'direct', agentIds, memberIds: [], unreadCount: 0, lastItemAt: NOW, createdAt: NOW };
}

export function wakeFor(agentId: string): WakeEvent {
  return {
    id: 'wke-' + agentId,
    ownerId: 'owner-1',
    agentId,
    sessionKey: agentId + ':conv-1',
    conversationId: 'conv-1',
    kind: 'user_message',
    origin: { type: 'user', id: 'member-1' },
    trusted: true,
    priority: 'user',
    payload: { text: 'hi' },
    at: NOW,
    status: 'accepted',
  };
}

export async function seed(): Promise<Store> {
  const store = createMemoryStore();
  await store.put('agents', agentDoc(AGENT, ['skl-alpha', 'skl-beta', 'skl-missing', 'skl-alpha']));
  await store.put('agents', agentDoc(PEER, ['skl-beta']));
  await store.put('conversations', conversationDoc('conv-1', [AGENT, PEER]));
  return store;
}

export async function systemContent(store: Store, agentId: string, skills: SkillsService = createFakeSkills(FIXTURE_SKILLS)): Promise<string> {
  const ctx = await buildContext(store, {
    agentId,
    conversationId: 'conv-1',
    sessionKey: agentId + ':conv-1',
    wake: [wakeFor(agentId)],
    home: { skills },
  });
  return contextText(ctx);
}

export function toolContext(store: Store, agentId: string): ToolContext {
  return {
    ownerId: 'owner-1',
    agentId,
    conversationId: 'conv-1',
    runId: 'run-1',
    store, blobs: createMemoryBlobStore(),
    enqueuer: new NoopEnqueuer(),
    wake: wakeFor(agentId),
    step: async (_name, fn) => fn(),
    signal: new AbortController().signal,
  };
}

export function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const part = result.content[0];
  return part !== undefined && part.type === 'text' && typeof part.text === 'string' ? part.text : '';
}

/** Delegate every read to `base` except one collection id, to exercise the unreadable path. */
export function failReadsOf(base: Store, collection: Collection, id: string): Store {
  return {
    ...base,
    async get<C extends Collection>(target: C, targetId: string): Promise<Doc<C> | null> {
      if (target === collection && targetId === id) throw new Error('record unreadable');
      return base.get(target, targetId);
    },
    async list<C extends Collection>(target: C, query?: ListQuery): Promise<ListPage<Doc<C>>> {
      return base.list(target, query);
    },
  };
}

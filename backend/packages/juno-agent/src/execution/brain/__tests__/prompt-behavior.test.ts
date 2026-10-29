import { describe, expect, it } from 'vitest';
import type { Agent, Conversation } from '@agent-desktop/public-contracts';
import type { Collection, Doc, ListPage, ListQuery, Store, WakeEvent } from '../../../contracts/index.js';
import { buildContext } from '../context.js';
import { contextText } from './context-text.js';

const NOW = '2026-10-06T00:00:00.000Z';

type StoredAgent = Agent & { ownerId?: string };

function mkAgent(overrides: Partial<StoredAgent> & { id: string }): StoredAgent {
  return {
    name: 'Agent ' + overrides.id,
    handle: 'handle-' + overrides.id,
    avatar: { shape: 'blob', color: 1, eyes: 'dot' },
    title: 'Role of ' + overrides.id,
    status: 'idle',
    section: 'Personal',
    pinned: false,
    lastActivity: '',
    unreadCount: 0,
    model: {
      planner: { provider: 'test', model: 'test' },
      computer: { provider: 'test', model: 'test' },
      fast: { provider: 'test', model: 'test' },
    },
    channels: [],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: true },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function mkConversation(overrides: Partial<Conversation> & { id: string }): Conversation {
  return {
    kind: 'direct',
    agentIds: [],
    memberIds: [],
    unreadCount: 0,
    lastItemAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

function mkWake(overrides: Partial<WakeEvent> & { id: string }): WakeEvent {
  return {
    ownerId: 'owner-1',
    agentId: 'agent-alpha',
    sessionKey: 'agent-alpha:conv-1',
    conversationId: 'conv-1',
    kind: 'user_message',
    origin: { type: 'user', id: 'member-1' },
    trusted: true,
    priority: 'user',
    payload: { text: 'hi' },
    at: NOW,
    status: 'accepted',
    ...overrides,
  };
}

interface Fixtures {
  agents?: StoredAgent[];
  conversations?: Conversation[];
}

function fakeStore(fixtures: Fixtures): Store {
  const agentMap = new Map<string, Agent>();
  for (const agent of fixtures.agents ?? []) agentMap.set(agent.id, agent);
  const conversationMap = new Map<string, Conversation>();
  for (const conversation of fixtures.conversations ?? []) conversationMap.set(conversation.id, conversation);
  const tables: { [K in Collection]?: Map<string, Doc<K>> } = {
    agents: agentMap,
    conversations: conversationMap,
  };
  const store: Store = {
    async tx<T>(fn: (inner: Store) => Promise<T>): Promise<T> {
      return fn(store);
    },
    async get<C extends Collection>(collection: C, id: string): Promise<Doc<C> | null> {
      const table = tables[collection];
      const doc = table?.get(id);
      return doc ?? null;
    },
    async list<C extends Collection>(collection: C, query?: ListQuery): Promise<ListPage<Doc<C>>> {
      const table = tables[collection];
      const limit = query?.limit ?? 20;
      const values = table ? [...table.values()] : [];
      return { items: values.slice(0, limit) };
    },
    async put<C extends Collection>(collection: C, doc: Doc<C>): Promise<Doc<C>> {
      void collection;
      return doc;
    },
    async patch(): Promise<never> {
      throw new Error('unused');
    },
    async delete(): Promise<void> {
    },
    async emit(): Promise<void> {
    },
  };
  return store;
}

function owned(agent: StoredAgent, ownerId: string): StoredAgent {
  return { ...agent, ownerId };
}

async function systemAndContent(fixtures: Fixtures): Promise<{ prompt: string; content: string }> {
  const ctx = await buildContext(fakeStore(fixtures), {
    agentId: 'agent-alpha',
    conversationId: 'conv-1',
    sessionKey: 'agent-alpha:conv-1',
    wake: [mkWake({ id: 'wke-gc3' })],
  });
  const content = contextText(ctx);
  return { prompt: ctx.systemPrompt, content };
}

describe('GC3 group prompt behavior', () => {
  it('GC3 identity stays authoritative when handles duplicate', async () => {
    const alpha = mkAgent({ id: 'agent-alpha', name: 'Alpha', handle: 'scout', title: 'Research' });
    const beta = mkAgent({ id: 'agent-beta', name: 'Beta', handle: 'scout', title: 'Engineering' });
    const { prompt, content } = await systemAndContent({
      agents: [owned(alpha, 'owner-1'), owned(beta, 'owner-1')],
      conversations: [mkConversation({ id: 'conv-1', kind: 'room', title: 'Trip planning', agentIds: ['agent-alpha', 'agent-beta'], memberIds: ['owner-1'] })],
    });
    expect(prompt).toContain('come from the Agent and persona sections below');
    expect(content).toContain('## Current identity (authoritative)');
    // The room section tells the agent never to take another agent's name; the Session section keeps the ids.
    expect(content).toContain(`"Trip planning", a room in the Juno app with the person you're helping and other agents.`);
    expect(content).toContain("Never take another agent's name");
    expect(content).toContain('"Alpha"');
    expect(content).toContain("'agent-alpha:conv-1'");
  });
});

describe('finishing the turn', () => {
  it('the frozen rules make a promised lookup happen in the same turn, never the last words of a reply', async () => {
    const { prompt } = await systemAndContent({
      agents: [owned(mkAgent({ id: 'agent-alpha' }), 'owner-1')],
      conversations: [mkConversation({ id: 'conv-1', agentIds: ['agent-alpha'], memberIds: ['owner-1'] })],
    });
    expect(prompt).toContain('Finish the job in this turn');
    expect(prompt).toContain('Never end a reply on "let me check"');
  });
});

describe('independent reads', () => {
  it('the frozen rules tell the model to send independent reads together and to split only on a dependency', async () => {
    const { prompt } = await systemAndContent({
      agents: [owned(mkAgent({ id: 'agent-alpha' }), 'owner-1')],
      conversations: [mkConversation({ id: 'conv-1', agentIds: ['agent-alpha'], memberIds: ['owner-1'] })],
    });
    expect(prompt).toContain('Independent reads (searches, files, calendar, memory lookups, snapshots of different pages) go out together in the same reply');
    expect(prompt).toContain('split them only when a call needs an earlier result');
  });
});

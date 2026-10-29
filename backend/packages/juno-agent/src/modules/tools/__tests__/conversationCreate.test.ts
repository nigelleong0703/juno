import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-desktop/public-contracts';
import type { Enqueuer, Store, ToolContext, ToolResult, WakeEvent } from '../../../contracts/index.js';
import { createMemoryStore } from '../../../testing/store.js';
import {
  MAX_CONVERSATION_CREATE_AGENTS,
  createConversationCreateTool,
  roomConversationIdForCreate,
} from '../tools/conversationCreate.js';
import { createConversationListTool } from '../tools/conversationList.js';

const OWNER = 'owner-1';
const SENDER = 'agent-1';
const BUDDY = 'agent-2';
const NOW = '2026-10-07T00:00:00.000Z';

class StubEnqueuer implements Enqueuer {
  calls: string[] = [];

  async enqueue(): Promise<{ accepted: boolean }> {
    this.calls.push('enqueue');
    return { accepted: true };
  }

  async stopRun(): Promise<void> {}

  async resolveAwakeable(): Promise<void> {}

  async scheduleRoutine(): Promise<void> {}
}

type TestAgent = Agent & { ownerId?: string };

function makeAgent(id: string, ownerId: string): TestAgent {
  return {
    id,
    name: 'Agent ' + id,
    handle: id,
    avatar: { shape: 'circle', color: 1, eyes: 'happy' },
    title: 'Agent role',
    status: 'idle',
    section: 'Agents',
    pinned: false,
    lastActivity: 'idle',
    unreadCount: 0,
    model: {
      planner: { provider: 'anthropic', model: 'claude-opus' },
      computer: { provider: 'anthropic', model: 'claude-opus' },
      fast: { provider: 'anthropic', model: 'claude-haiku' },
    },
    channels: [{ kind: 'chat', status: 'connected' }],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdBy: ownerId,
    ownerId,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeWake(): WakeEvent {
  return {
    id: 'wke-1',
    ownerId: OWNER,
    agentId: SENDER,
    sessionKey: SENDER + ':conv-1',
    conversationId: 'conv-1',
    kind: 'user_message',
    origin: { type: 'user' },
    trusted: true,
    priority: 'user',
    payload: {},
    at: NOW,
    status: 'accepted',
  };
}

function makeCtx(store: Store, enqueuer: StubEnqueuer, runId: string): ToolContext {
  return {
    ownerId: OWNER,
    agentId: SENDER,
    conversationId: 'conv-1',
    runId,
    store, blobs: createMemoryBlobStore(),
    enqueuer,
    wake: makeWake(),
    step: async (name, fn) => fn(),
    signal: new AbortController().signal,
  };
}

function textOf(result: ToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected a text result');
  return first.text;
}

function detailString(result: ToolResult, key: string): string {
  const details = result.details;
  if (typeof details !== 'object' || details === null) throw new Error('expected details for ' + key);
  const value: unknown = Reflect.get(details, key);
  if (typeof value !== 'string') throw new Error('expected string detail ' + key);
  return value;
}

function detailStringList(result: ToolResult, key: string): string[] {
  const details = result.details;
  if (typeof details !== 'object' || details === null) throw new Error('expected details for ' + key);
  const value: unknown = Reflect.get(details, key);
  if (!Array.isArray(value)) throw new Error('expected list detail ' + key);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('expected string entries in ' + key);
    out.push(item);
  }
  return out;
}

async function conversationCount(store: Store): Promise<number> {
  const page = await store.list('conversations');
  return page.items.length;
}

describe('conversation_create', () => {
  it('creates a room with the sender and owner auto-included and visible via conversation_list', async () => {
    const store = createMemoryStore();
    const enqueuer = new StubEnqueuer();
    await store.put('agents', makeAgent(SENDER, OWNER));
    await store.put('agents', makeAgent(BUDDY, OWNER));
    const tool = createConversationCreateTool({ store });
    expect(tool.name).toBe('conversation_create');
    expect(tool.replay).toBe('never');
    expect(tool.sideEffect).toBe(true);

    const result = await tool.execute({ title: 'Ops channel', memberAgentIds: [BUDDY] }, makeCtx(store, enqueuer, 'run-room-1'));
    expect(result.isError).not.toBe(true);
    const conversationId = detailString(result, 'conversationId');
    expect(conversationId.startsWith('room_')).toBe(true);
    expect(detailString(result, 'title')).toBe('Ops channel');
    const members = detailStringList(result, 'memberAgentIds');
    expect(members.length).toBe(2);
    expect(members.includes(SENDER)).toBe(true);
    expect(members.includes(BUDDY)).toBe(true);

    const stored = await store.get('conversations', conversationId);
    expect(stored !== null).toBe(true);
    if (stored === null) throw new Error('expected the created room to be stored');
    expect(stored.kind).toBe('room');
    expect(stored.title).toBe('Ops channel');
    expect(stored.memberIds).toEqual([OWNER]);
    expect(stored.roomMode).toBe('mention');
    expect(stored.hostAgentId).toBe(SENDER);

    const listTool = createConversationListTool({ store });
    const listed = await listTool.execute({}, makeCtx(store, enqueuer, 'run-room-1'));
    expect(listed.isError).not.toBe(true);
    expect(textOf(listed).includes(conversationId)).toBe(true);

    expect(enqueuer.calls.length).toBe(0);
  });

  it('auto-includes the sender and dedupes repeats', async () => {
    const store = createMemoryStore();
    const enqueuer = new StubEnqueuer();
    await store.put('agents', makeAgent(SENDER, OWNER));
    await store.put('agents', makeAgent(BUDDY, OWNER));
    const tool = createConversationCreateTool({ store });
    const result = await tool.execute(
      { title: 'Dedupe room', memberAgentIds: [SENDER, BUDDY, BUDDY] },
      makeCtx(store, enqueuer, 'run-dedupe-1'),
    );
    expect(result.isError).not.toBe(true);
    expect(detailStringList(result, 'memberAgentIds').length).toBe(2);
  });

  it('denies foreign and unknown agents with zero effects', async () => {
    const store = createMemoryStore();
    const enqueuer = new StubEnqueuer();
    await store.put('agents', makeAgent(SENDER, OWNER));
    await store.put('agents', makeAgent('agent-foreign', 'owner-2'));
    const tool = createConversationCreateTool({ store });

    const foreign = await tool.execute(
      { title: 'Foreign room', memberAgentIds: ['agent-foreign'] },
      makeCtx(store, enqueuer, 'run-deny-1'),
    );
    expect(foreign.isError).toBe(true);

    const unknown = await tool.execute(
      { title: 'Ghost room', memberAgentIds: ['agent-nope'] },
      makeCtx(store, enqueuer, 'run-deny-2'),
    );
    expect(unknown.isError).toBe(true);

    expect(await conversationCount(store)).toBe(0);
    expect(enqueuer.calls.length).toBe(0);
  });

  it('rejects blank titles, blank member ids and over-limit membership', async () => {
    const store = createMemoryStore();
    const enqueuer = new StubEnqueuer();
    await store.put('agents', makeAgent(SENDER, OWNER));
    const tool = createConversationCreateTool({ store });

    const blankTitle = await tool.execute({ title: '   ', memberAgentIds: [] }, makeCtx(store, enqueuer, 'run-bad-1'));
    expect(blankTitle.isError).toBe(true);

    const blankMember = await tool.execute({ title: 'Bad member', memberAgentIds: ['  '] }, makeCtx(store, enqueuer, 'run-bad-2'));
    expect(blankMember.isError).toBe(true);

    const tooMany: string[] = [];
    for (let i = 0; i < MAX_CONVERSATION_CREATE_AGENTS; i += 1) {
      tooMany.push('agent-extra-' + String(i));
    }
    const overLimit = await tool.execute({ title: 'Crowded room', memberAgentIds: tooMany }, makeCtx(store, enqueuer, 'run-bad-3'));
    expect(overLimit.isError).toBe(true);
    expect(textOf(overLimit).includes('member limit')).toBe(true);

    expect(await conversationCount(store)).toBe(0);
  });

  it('reuses the same record on retry and refuses unrelated collisions', async () => {
    const store = createMemoryStore();
    const enqueuer = new StubEnqueuer();
    await store.put('agents', makeAgent(SENDER, OWNER));
    await store.put('agents', makeAgent(BUDDY, OWNER));
    const tool = createConversationCreateTool({ store });
    const args = { title: 'Retry room', memberAgentIds: [BUDDY] };

    const first = await tool.execute(args, makeCtx(store, enqueuer, 'run-retry-1'));
    const second = await tool.execute(args, makeCtx(store, enqueuer, 'run-retry-1'));
    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    expect(detailString(second, 'conversationId')).toBe(detailString(first, 'conversationId'));
    expect(await conversationCount(store)).toBe(1);

    const clashId = roomConversationIdForCreate('run-clash-1', { title: 'Clash', agentIds: [SENDER], roomMode: 'mention', ownerId: OWNER });
    await store.put('conversations', {
      id: clashId,
      kind: 'peer',
      agentIds: [SENDER, BUDDY],
      memberIds: [OWNER],
      unreadCount: 0,
      lastItemAt: NOW,
      createdAt: NOW,
    });
    const clash = await tool.execute({ title: 'Clash', memberAgentIds: [] }, makeCtx(store, enqueuer, 'run-clash-1'));
    expect(clash.isError).toBe(true);
    expect(textOf(clash).includes('refusing to overwrite')).toBe(true);
    const kept = await store.get('conversations', clashId);
    expect(kept !== null).toBe(true);
    if (kept === null) throw new Error('expected the colliding record to be preserved');
    expect(kept.kind).toBe('peer');
  });

  it('denies hostile user ids explicitly instead of ignoring them', async () => {
    const store = createMemoryStore();
    const enqueuer = new StubEnqueuer();
    await store.put('agents', makeAgent(SENDER, OWNER));
    const tool = createConversationCreateTool({ store });
    const hostile = await tool.execute(
      { title: 'Hijack room', memberAgentIds: [OWNER, 'owner-2'] },
      makeCtx(store, enqueuer, 'run-hostile-1'),
    );
    expect(hostile.isError).toBe(true);
    expect(await conversationCount(store)).toBe(0);
    expect(enqueuer.calls.length).toBe(0);
  });

  it('emits conversation.created atomically and reports storage failures without claiming creation', async () => {
    const store = createMemoryStore();
    const enqueuer = new StubEnqueuer();
    await store.put('agents', makeAgent(SENDER, OWNER));
    await store.put('agents', makeAgent(BUDDY, OWNER));
    const tool = createConversationCreateTool({ store });
    const result = await tool.execute({ title: 'Event room', memberAgentIds: [BUDDY] }, makeCtx(store, enqueuer, 'run-event-1'));
    expect(result.isError).not.toBe(true);
    const conversationId = detailString(result, 'conversationId');
    const events = await store.eventBus.since(0, 50);
    const created = events.filter((e) => e.event.type === 'conversation.created');
    expect(created.length).toBe(1);
    const first = created[0];
    if (first === undefined) throw new Error('expected one conversation.created event');
    if (first.event.type !== 'conversation.created') throw new Error('expected a conversation.created event');
    expect(first.event.conversation.id).toBe(conversationId);
    const broken: Store = { ...store, tx: async () => { throw new Error('store down'); } };
    const failing = createConversationCreateTool({ store: broken });
    const failed = await failing.execute({ title: 'Lost room', memberAgentIds: [BUDDY] }, makeCtx(broken, enqueuer, 'run-event-2'));
    expect(failed.isError).toBe(true);
    expect(textOf(failed).includes('could not be created')).toBe(true);
    expect(await conversationCount(store)).toBe(1);
  });
});

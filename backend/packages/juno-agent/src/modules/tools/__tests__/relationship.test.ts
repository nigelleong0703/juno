import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { createToolRegistry } from '../index.js';
import { createMemoryStore } from '../../../testing/store.js';
import type { Store, Enqueuer, WakeEvent, ToolContext, ToolResult, Tool } from '../../../contracts/index.js';
import type { Agent } from '@agent-desktop/public-contracts';

const OWNER = 'member-robin';
const OTHER_OWNER = 'member-priya';
const NOW = '2026-10-06T00:00:00.000Z';

interface AgentOverride {
  ownerId?: string;
  createdBy?: string;
  sharing?: { publishedToTeam: boolean };
}

type TestAgent = Agent & { ownerId?: string };

class RecordingEnqueuer implements Enqueuer {
  events: WakeEvent[] = [];
  failNext = false;
  refuseNext = false;
  /** H-78: like the real awaitDecision call, a Session refusal (hop_limit, ...) comes back as accepted:false. */
  sessionRefusal: string | undefined;
  optsSeen: Array<{ delayMs?: number; awaitDecision?: boolean } | undefined> = [];
  async enqueue(event: WakeEvent, opts?: { delayMs?: number; awaitDecision?: boolean }) {
    this.optsSeen.push(opts);
    if (this.sessionRefusal !== undefined && opts?.awaitDecision === true) return { accepted: false, reason: this.sessionRefusal };
    if (this.failNext) {
      this.failNext = false;
      throw new Error('ingress down');
    }
    if (this.refuseNext) {
      this.refuseNext = false;
      return { accepted: false, reason: 'overloaded' };
    }
    this.events.push(event);
    return { accepted: true };
  }
  async stopRun() {}
  async resolveAwakeable() {}
  async scheduleRoutine() {}
}

function agentDoc(id: string, overrides: AgentOverride = {}): TestAgent {
  return {
    id,
    name: 'Agent ' + id,
    handle: id,
    avatar: { shape: 'circle', color: 1, eyes: 'happy' },
    title: 'Role of ' + id,
    description: 'test personality that must never leak',
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
    createdBy: OWNER,
    ownerId: OWNER,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function ctxFor(store: Store, enqueuer: Enqueuer, agentId = 'agent-a', ownerId = OWNER, hopDepth?: number): ToolContext {
  const wake: WakeEvent = {
    id: 'wke_1',
    ownerId,
    agentId,
    sessionKey: agentId + ':conv-a',
    conversationId: 'conv-a',
    kind: 'user_message',
    origin: { type: 'user', id: ownerId },
    trusted: true,
    priority: 'user',
    payload: { text: 'hi' },
    at: NOW,
    status: 'accepted',
  };
  if (hopDepth !== undefined) wake.hop = { chainId: 'chain-1', depth: hopDepth };
  return {
    ownerId,
    agentId,
    conversationId: 'conv-a',
    runId: 'run-1',
    store, blobs: createMemoryBlobStore(),
    enqueuer,
    wake,
    step: async (_name, fn) => fn(),
    signal: new AbortController().signal,
  };
}

async function seedBase(store: Store) {
  await store.put('agents', agentDoc('agent-a'));
  await store.put('agents', agentDoc('agent-b'));
  await store.put('conversations', {
    id: 'conv-a',
    kind: 'direct',
    title: 'A chat',
    agentIds: ['agent-a'],
    memberIds: [OWNER],
    unreadCount: 0,
    lastItemAt: NOW,
    createdAt: NOW,
  });
}

async function seedRoom(store: Store, id: string, agentIds: string[]) {
  await store.put('conversations', {
    id,
    kind: 'room',
    title: 'Lab',
    agentIds,
    memberIds: [OWNER],
    unreadCount: 0,
    lastItemAt: NOW,
    createdAt: NOW,
  });
}

function textOf(result: ToolResult): string {
  return JSON.stringify(result.content);
}

function field(doc: unknown, key: string): unknown {
  if (typeof doc !== 'object' || doc === null) return undefined;
  return Reflect.get(doc, key);
}

function detailList(result: ToolResult, key: string): Array<Record<string, unknown>> {
  const details = result.details;
  if (details === undefined) return [];
  const value: unknown = details[key];
  if (!Array.isArray(value)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (typeof item === 'object' && item !== null) {
      const rec: Record<string, unknown> = {};
      for (const k of Object.keys(item)) rec[k] = Reflect.get(item, k);
      out.push(rec);
    }
  }
  return out;
}

function detailString(result: ToolResult, key: string): string | undefined {
  const details = result.details;
  if (details === undefined) return undefined;
  const value: unknown = details[key];
  return typeof value === 'string' ? value : undefined;
}

function needTool(tool: Tool | undefined, name: string): Tool {
  if (tool === undefined) throw new Error(name + ' missing');
  return tool;
}

describe('relationship tools', () => {
  let store: Store;
  let enqueuer: RecordingEnqueuer;

  beforeEach(async () => {
    store = createMemoryStore();
    enqueuer = new RecordingEnqueuer();
    await seedBase(store);
  });

  it('directory shows own peers, hiding foreign-owner and unknown ones', async () => {
    await store.put('agents', agentDoc('agent-shared', { ownerId: OTHER_OWNER, createdBy: OTHER_OWNER, sharing: { publishedToTeam: true } }));
    await store.put('agents', agentDoc('agent-private', { ownerId: OTHER_OWNER, createdBy: OTHER_OWNER, sharing: { publishedToTeam: false } }));
    const unknownDoc = agentDoc('agent-unknown');
    unknownDoc.ownerId = undefined;
    unknownDoc.createdBy = undefined;
    await store.put('agents', unknownDoc);
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const result = await needTool(registry.get('agent_directory'), 'agent_directory').execute({}, ctxFor(store, enqueuer));
    expect(result.isError).not.toBe(true);
    const text = textOf(result);
    expect(text).toContain('agent-b');
    expect(text).not.toContain('agent-shared');
    expect(text).not.toContain('agent-private');
    expect(text).not.toContain('agent-unknown');
    expect(text).not.toContain('must never leak');
    const agents = detailList(result, 'agents');
    expect(agents.length).toBe(1);
    for (const entry of agents) {
      expect(Object.keys(entry).sort()).toEqual(['handle', 'id', 'name', 'title']);
    }
  });

  it('directory paginates across opaque cursors', async () => {
    await store.put('agents', agentDoc('agent-c'));
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const tool = needTool(registry.get('agent_directory'), 'agent_directory');
    const first = await tool.execute({ limit: 1 }, ctxFor(store, enqueuer));
    expect(detailList(first, 'agents').length).toBe(1);
    const next = detailString(first, 'nextCursor');
    expect(typeof next).toBe('string');
    if (next === undefined) throw new Error('nextCursor missing');
    const second = await tool.execute({ limit: 1, cursor: next }, ctxFor(store, enqueuer));
    expect(detailList(second, 'agents').length).toBe(1);
    expect(detailString(second, 'nextCursor')).toBeUndefined();
    expect(JSON.stringify(detailList(first, 'agents'))).not.toBe(JSON.stringify(detailList(second, 'agents')));
    const bad = await tool.execute({ cursor: 'nope' }, ctxFor(store, enqueuer));
    expect(bad.isError).toBe(true);
  });

  it('directory reaches teammates past one hundred foreign rows', async () => {
    for (let i = 0; i < 120; i += 1) {
      const n = String(i).padStart(3, '0');
      await store.put('agents', agentDoc('aaa-foreign-' + n, { ownerId: 'stranger', createdBy: 'stranger' }));
    }
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const tool = needTool(registry.get('agent_directory'), 'agent_directory');
    const result = await tool.execute({ limit: 50 }, ctxFor(store, enqueuer));
    expect(result.isError).not.toBe(true);
    const text = textOf(result);
    expect(text).not.toContain('aaa-foreign-');
    expect(text).toContain('agent-b');
    expect(detailString(result, 'nextCursor')).toBeUndefined();
  });

  it('directory fails closed without an established owner', async () => {
    const orphanDoc = agentDoc('agent-a');
    orphanDoc.ownerId = undefined;
    orphanDoc.createdBy = 'someone-else';
    await store.put('agents', orphanDoc);
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const tool = needTool(registry.get('agent_directory'), 'agent_directory');
    const result = await tool.execute({}, ctxFor(store, enqueuer));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('ownership cannot be established');
  });

  it('directory denies a foreign requester borrowing the agent identity', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const tool = needTool(registry.get('agent_directory'), 'agent_directory');
    const result = await tool.execute({}, ctxFor(store, enqueuer, 'agent-a', 'stranger'));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not the recorded owner');
  });

  it('conversation list returns member conversations with routing and no item content', async () => {
    await store.put(
      'items',
      {
        id: 'itm-secret',
        conversationId: 'conv-a',
        type: 'agent_message',
        agentId: 'agent-a',
        markdown: 'SECRET-ITEM-CONTENT',
        citations: [],
        at: NOW,
      },
      { conversationId: 'conv-a' },
    );
    await store.put('conversations', {
      id: 'conv-other',
      kind: 'direct',
      agentIds: ['agent-b'],
      memberIds: [OWNER],
      unreadCount: 0,
      lastItemAt: NOW,
      createdAt: NOW,
    });
    await seedRoom(store, 'room-1', ['agent-a', 'agent-b']);
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const tool = needTool(registry.get('conversation_list'), 'conversation_list');
    const result = await tool.execute({}, ctxFor(store, enqueuer));
    expect(result.isError).not.toBe(true);
    const text = textOf(result);
    expect(text).toContain('conv-a');
    expect(text).toContain('room-1');
    expect(text).not.toContain('conv-other');
    expect(JSON.stringify(result.details)).not.toContain('SECRET-ITEM-CONTENT');
    const conversations = detailList(result, 'conversations');
    expect(conversations.length).toBe(2);
    const direct = conversations.find((c) => c['id'] === 'conv-a');
    expect(direct !== undefined ? direct['sessionKey'] : undefined).toBe('agent-a:conv-a');
  });

  it('conversation list withholds rooms containing foreign members', async () => {
    await store.put('agents', agentDoc('agent-foreign', { ownerId: 'stranger', createdBy: 'stranger' }));
    await store.put('conversations', {
      id: 'room-mixed',
      kind: 'room',
      title: 'Mixed',
      agentIds: ['agent-a', 'agent-foreign'],
      memberIds: [OWNER],
      unreadCount: 0,
      lastItemAt: NOW,
      createdAt: NOW,
    });
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const tool = needTool(registry.get('conversation_list'), 'conversation_list');
    const result = await tool.execute({}, ctxFor(store, enqueuer));
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).not.toContain('room-mixed');
    expect(textOf(result)).toContain('conv-a');
  });

  it('conversation list reaches entries past one hundred foreign rows', async () => {
    for (let i = 0; i < 110; i += 1) {
      const n = String(i).padStart(3, '0');
      await store.put('conversations', {
        id: 'aaa-conv-' + n,
        kind: 'direct',
        agentIds: ['someone-else'],
        memberIds: ['stranger'],
        unreadCount: 0,
        lastItemAt: NOW,
        createdAt: NOW,
      });
    }
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const tool = needTool(registry.get('conversation_list'), 'conversation_list');
    const result = await tool.execute({ limit: 50 }, ctxFor(store, enqueuer));
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain('conv-a');
    expect(textOf(result)).not.toContain('aaa-conv-');
  });

  it('write tools fence replay as never', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    for (const name of ['message_agent', 'post_to_room', 'handoff', 'agent_create']) {
      expect(needTool(registry.get(name), name).replay).toBe('never');
    }
  });

  it('message_agent denies foreign, missing and self targets in a room with no effects', async () => {
    await store.put('agents', agentDoc('agent-foreign', { ownerId: 'stranger', createdBy: 'stranger' }));
    await store.put('agents', agentDoc('agent-published', { ownerId: 'stranger', createdBy: 'stranger', sharing: { publishedToTeam: true } }));
    await seedRoom(store, 'room-1', ['agent-a', 'agent-b']);
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const tool = needTool(registry.get('message_agent'), 'message_agent');
    const ctx = { ...ctxFor(store, enqueuer), conversationId: 'room-1' };
    for (const target of ['agent-foreign', 'agent-missing', 'agent-a', 'agent-published']) {
      const result = await tool.execute({ target, message: 'nope' }, ctx);
      expect(result.isError).toBe(true);
    }
    expect(enqueuer.events.length).toBe(0);
    expect((await store.list('items', { limit: 100 })).items.length).toBe(0);
  });

  it('post_to_room rejects unknown rooms, wrong kinds and non-members before writing', async () => {
    await store.put('agents', agentDoc('agent-c'));
    await seedRoom(store, 'room-1', ['agent-a', 'agent-b']);
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const tool = needTool(registry.get('post_to_room'), 'post_to_room');
    const ctx = ctxFor(store, enqueuer);
    const missing = await tool.execute({ roomId: 'room-missing', message: 'x' }, ctx);
    const wrongKind = await tool.execute({ roomId: 'conv-a', message: 'x' }, ctx);
    const unknownMention = await tool.execute({ roomId: 'room-1', message: 'x', mentions: ['agent-missing'] }, ctx);
    const hiddenJoin = await tool.execute({ roomId: 'room-1', message: 'x', mentions: ['agent-c'] }, ctx);
    expect(missing.isError).toBe(true);
    expect(wrongKind.isError).toBe(true);
    expect(unknownMention.isError).toBe(true);
    expect(hiddenJoin.isError).toBe(true);
    expect(textOf(wrongKind)).toContain('not a room');
    expect(textOf(hiddenJoin)).toContain('hidden join');
    expect(enqueuer.events.length).toBe(0);
    const items = await store.list('items', { limit: 100 });
    expect(items.items.length).toBe(0);
  });

  it('post_to_room and handoff deny deep hop chains before writes', async () => {
    await seedRoom(store, 'room-1', ['agent-a', 'agent-b']);
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const deep = ctxFor(store, enqueuer, 'agent-a', OWNER, 999);
    const post = await needTool(registry.get('post_to_room'), 'post_to_room').execute({ roomId: 'room-1', message: 'loop' }, deep);
    const off = await needTool(registry.get('handoff'), 'handoff').execute({ roomId: 'room-1', to: 'agent-b', task: 'loop' }, deep);
    expect(post.isError).toBe(true);
    expect(off.isError).toBe(true);
    expect(textOf(post)).toContain('exceeds limit');
    expect(enqueuer.events.length).toBe(0);
    const items = await store.list('items', { limit: 100 });
    expect(items.items.length).toBe(0);
  });

  it('post_to_room reports a queued mention and hop chain', async () => {
    await seedRoom(store, 'room-1', ['agent-a', 'agent-b']);
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const tool = needTool(registry.get('post_to_room'), 'post_to_room');
    const result = await tool.execute({ roomId: 'room-1', message: 'hi', mentions: ['agent-b'] }, ctxFor(store, enqueuer));
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain('mention queued for 1 agent(s)');
    expect(enqueuer.events.length).toBe(1);
    const event = enqueuer.events[0];
    if (event === undefined) throw new Error('wake missing');
    expect(event.sessionKey).toBe('agent-b:room-1');
    expect(event.hop?.depth).toBe(1);
  });

  it('post_to_room reports partial queueing instead of claiming success', async () => {
    await seedRoom(store, 'room-1', ['agent-a', 'agent-b']);
    enqueuer.refuseNext = true;
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const tool = needTool(registry.get('post_to_room'), 'post_to_room');
    const result = await tool.execute({ roomId: 'room-1', message: 'hi', mentions: ['agent-b'] }, ctxFor(store, enqueuer));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('mention wake was not queued for: agent-b');
    const items = await store.list('items', { limit: 100 });
    expect(items.items.length).toBe(1);
  });

  it('handoff queue refusal is reported, not claimed as success', async () => {
    await seedRoom(store, 'room-1', ['agent-a', 'agent-b']);
    enqueuer.failNext = true;
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const tool = needTool(registry.get('handoff'), 'handoff');
    const result = await tool.execute({ roomId: 'room-1', to: 'agent-b', task: 'take over' }, ctxFor(store, enqueuer));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('was not queued');
  });

  it('handoff to a room non-member is rejected before writes', async () => {
    await seedRoom(store, 'room-1', ['agent-a']);
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const tool = needTool(registry.get('handoff'), 'handoff');
    const result = await tool.execute({ roomId: 'room-1', to: 'agent-b', task: 'take over' }, ctxFor(store, enqueuer));
    expect(result.isError).toBe(true);
    expect(enqueuer.events.length).toBe(0);
    const items = await store.list('items', { limit: 100 });
    expect(items.items.length).toBe(0);
  });

  it('agent_create inherits the requester computer with ownership', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const tool = needTool(registry.get('agent_create'), 'agent_create');
    const result = await tool.execute({ name: 'Newbie' }, ctxFor(store, enqueuer));
    expect(result.isError).not.toBe(true);
    const page = await store.list('agents', { limit: 100 });
    const created = page.items.find((a) => a.id !== 'agent-a' && a.id !== 'agent-b');
    expect(field(created, 'macAccess')).toBe(false);
    expect(field(created, 'createdBy')).toBe(OWNER);
    expect(field(created, 'ownerId')).toBe(OWNER);
    expect(field(created, 'sharing')).toEqual({ publishedToTeam: false });
  });

  it('message_agent names the refused mention and its reason when the Session refuses it (H-78)', async () => {
    await seedRoom(store, 'room-1', ['agent-a', 'agent-b']);
    enqueuer.sessionRefusal = 'hop_limit';
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const tool = needTool(registry.get('message_agent'), 'message_agent');
    const result = await tool.execute({ target: 'agent-b', message: 'hello' }, { ...ctxFor(store, enqueuer), conversationId: 'room-1' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('mention wake was not queued for: agent-b (hop_limit)');
    expect(textOf(result)).not.toContain('Message posted');
    expect(enqueuer.optsSeen).toEqual([{ awaitDecision: true }]);
  });

  it('handoff says the handoff was not delivered when the Session refuses it (H-78)', async () => {
    await seedRoom(store, 'room-1', ['agent-a', 'agent-b']);
    enqueuer.sessionRefusal = 'peer_cost_cap';
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const tool = needTool(registry.get('handoff'), 'handoff');
    const result = await tool.execute({ roomId: 'room-1', to: 'agent-b', task: 'take over' }, ctxFor(store, enqueuer));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not delivered');
    expect(textOf(result)).toContain('peer_cost_cap');
    expect(enqueuer.optsSeen).toEqual([{ awaitDecision: true }]);
  });

  it('post_to_room names the refused mention and its reason (H-78)', async () => {
    await seedRoom(store, 'room-1', ['agent-a', 'agent-b']);
    enqueuer.sessionRefusal = 'hop_limit';
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const tool = needTool(registry.get('post_to_room'), 'post_to_room');
    const result = await tool.execute({ roomId: 'room-1', message: 'hi', mentions: ['agent-b'] }, ctxFor(store, enqueuer));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('mention wake was not queued for: agent-b (hop_limit)');
    expect(enqueuer.optsSeen).toEqual([{ awaitDecision: true }]);
  });
});

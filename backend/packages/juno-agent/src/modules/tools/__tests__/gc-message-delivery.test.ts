import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { createToolRegistry } from '../index.js';
import { wakeMessage } from '../../../execution/brain/messages.js';
import { createMemoryStore } from '../../../testing/store.js';
import type { Store, Enqueuer, WakeEvent, ToolContext, ToolResult, Tool } from '../../../contracts/index.js';
import type { Agent } from '@agent-desktop/public-contracts';

const OWNER = 'gc-owner';
const NOW = '2026-10-06T00:00:00.000Z';

class RecordingEnqueuer implements Enqueuer {
  events: WakeEvent[] = [];
  refuseNext = false;
  async enqueue(event: WakeEvent) {
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

type TestAgent = Agent & { ownerId?: string };

function agentDoc(id: string, name: string): TestAgent {
  return {
    id, name, handle: id,
    avatar: { shape: 'circle', color: 1, eyes: 'happy' },
    title: 'Role', status: 'idle', section: 'Agents', pinned: false,
    lastActivity: 'idle', unreadCount: 0,
    model: {
      planner: { provider: 'anthropic', model: 'claude-opus' },
      computer: { provider: 'anthropic', model: 'claude-opus' },
      fast: { provider: 'anthropic', model: 'claude-haiku' },
    },
    channels: [], macAccess: false, skillIds: [], pluginIds: [],
    sharing: { publishedToTeam: false }, createdBy: OWNER, ownerId: OWNER,
    createdAt: NOW, updatedAt: NOW,
  };
}

function ctxFor(store: Store, enqueuer: Enqueuer, agentId: string, conversationId: string): ToolContext {
  return {
    ownerId: OWNER, agentId, conversationId, runId: 'run-1', store, blobs: createMemoryBlobStore(), enqueuer,
    wake: {
      id: 'wke-1', ownerId: OWNER, agentId, sessionKey: agentId + ':' + conversationId,
      conversationId, kind: 'user_message', origin: { type: 'user', id: OWNER },
      trusted: true, priority: 'user', payload: { text: 'hi' }, at: NOW, status: 'accepted',
    },
    step: async (_name, fn) => fn(),
    signal: new AbortController().signal,
  };
}

function needTool(tool: Tool | undefined, name: string): Tool {
  if (tool === undefined) throw new Error(name + ' missing');
  return tool;
}

function detailString(result: ToolResult, key: string): string | undefined {
  const value: unknown = result.details?.[key];
  return typeof value === 'string' ? value : undefined;
}

async function roomMarkdowns(store: Store, roomId: string): Promise<string[]> {
  const all = await store.list('items', { limit: 100 });
  const out: string[] = [];
  for (const item of all.items) {
    if (item.type === 'agent_message' && item.conversationId === roomId) out.push(item.markdown);
  }
  return out;
}

describe('gc2 group delivery', () => {
  let store: Store;
  let enqueuer: RecordingEnqueuer;

  beforeEach(async () => {
    store = createMemoryStore();
    enqueuer = new RecordingEnqueuer();
    await store.put('agents', agentDoc('agent-a', 'Ada'));
    await store.put('agents', agentDoc('agent-b', 'Juno'));
    await store.put('agents', agentDoc('agent-c', '[sneaky](http://evil)'));
    await store.put('agents', agentDoc('agent-out', 'Outsider'));
    await store.put('conversations', {
      id: 'room-1', kind: 'room', title: 'Lab',
      agentIds: ['agent-a', 'agent-b', 'agent-c'], memberIds: [OWNER],
      unreadCount: 0, lastItemAt: NOW, createdAt: NOW,
    });
    await store.put('conversations', {
      id: 'conv-a', kind: 'direct', title: 'Solo',
      agentIds: ['agent-a'], memberIds: [OWNER],
      unreadCount: 0, lastItemAt: NOW, createdAt: NOW,
    });
  });

  it('send_message targets stay visible in the current room and wake there', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const before = (await store.list('conversations', { limit: 50 })).items.length;
    const result = await needTool(registry.get('send_message'), 'send_message').execute(
      { kind: 'text', text: 'Please verify the result.', targetAgentIds: ['agent-b'] },
      ctxFor(store, enqueuer, 'agent-a', 'room-1'));
    expect(result.isError).not.toBe(true);
    const markdowns = await roomMarkdowns(store, 'room-1');
    expect(markdowns.length).toBe(1);
    expect(markdowns[0]).toContain('Please verify the result.');
    expect(markdowns[0]).toContain('@Juno');
    expect(enqueuer.events.length).toBe(1);
    expect(enqueuer.events[0]?.conversationId).toBe('room-1');
    expect(enqueuer.events[0]?.sessionKey).toBe('agent-b:room-1');
    expect(enqueuer.events[0]?.kind).toBe('room_mention');
    const after = (await store.list('conversations', { limit: 50 })).items.length;
    expect(after).toBe(before);
  });

  it('every agent-to-agent wake carries the sender\'s name and role, so the receiver sees "[from agent Ada (Role)]" and not an id', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const ctx = ctxFor(store, enqueuer, 'agent-a', 'room-1');
    await needTool(registry.get('send_message'), 'send_message').execute({ kind: 'text', text: 'Please verify.', targetAgentIds: ['agent-b'] }, ctx);
    await needTool(registry.get('post_to_room'), 'post_to_room').execute({ roomId: 'room-1', message: 'Look at this', mentions: ['agent-b'] }, ctx);
    await needTool(registry.get('handoff'), 'handoff').execute({ roomId: 'room-1', to: 'agent-b', task: 'Take it from here' }, ctx);
    expect(enqueuer.events).toHaveLength(3);
    for (const event of enqueuer.events) {
      expect(event.origin).toEqual({ type: 'agent', id: 'agent-a' });
      expect(event.payload).toMatchObject({ fromAgentName: 'Ada', fromAgentRole: 'Role' });
      expect(String(wakeMessage(event).content)).toMatch(/^\[from agent Ada \(Role\)\] /);
    }
  });

  it('send_message dedupes repeated targets into a single wake', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const result = await needTool(registry.get('send_message'), 'send_message').execute(
      { kind: 'text', text: 'Hello both.', targetAgentIds: ['agent-b', 'agent-b', 'agent-c'] },
      ctxFor(store, enqueuer, 'agent-a', 'room-1'));
    expect(result.isError).not.toBe(true);
    expect(enqueuer.events.length).toBe(2);
    const markdowns = await roomMarkdowns(store, 'room-1');
    const junoHits = markdowns[0] === undefined ? 0 : markdowns[0].split('@Juno').length - 1;
    expect(junoHits).toBe(1);
  });

  it('send_message addressed only to self fails without writing', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const result = await needTool(registry.get('send_message'), 'send_message').execute(
      { kind: 'text', text: 'Talking to myself.', targetAgentIds: ['agent-a'] },
      ctxFor(store, enqueuer, 'agent-a', 'room-1'));
    expect(result.isError).toBe(true);
    expect(await roomMarkdowns(store, 'room-1')).toEqual([]);
    expect(enqueuer.events.length).toBe(0);
  });

  it('send_message denies a target outside the room without writing', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const result = await needTool(registry.get('send_message'), 'send_message').execute(
      { kind: 'text', text: 'Sneaky join.', targetAgentIds: ['agent-out'] },
      ctxFor(store, enqueuer, 'agent-a', 'room-1'));
    expect(result.isError).toBe(true);
    expect(await roomMarkdowns(store, 'room-1')).toEqual([]);
    expect(enqueuer.events.length).toBe(0);
  });

  it('send_message with targets outside a room is refused', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const result = await needTool(registry.get('send_message'), 'send_message').execute(
      { kind: 'text', text: 'Wrong place.', targetAgentIds: ['agent-b'] },
      ctxFor(store, enqueuer, 'agent-a', 'conv-a'));
    expect(result.isError).toBe(true);
    expect(enqueuer.events.length).toBe(0);
  });

  it('plain text never wakes from @names in the body', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const result = await needTool(registry.get('send_message'), 'send_message').execute(
      { kind: 'text', text: '@ghost please help' },
      ctxFor(store, enqueuer, 'agent-a', 'room-1'));
    expect(result.isError).not.toBe(true);
    expect(enqueuer.events.length).toBe(0);
  });

  it('stored display names are escaped so markdown cannot be injected', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const result = await needTool(registry.get('send_message'), 'send_message').execute(
      { kind: 'text', text: 'Heads up.', targetAgentIds: ['agent-c'] },
      ctxFor(store, enqueuer, 'agent-a', 'room-1'));
    expect(result.isError).not.toBe(true);
    const markdowns = await roomMarkdowns(store, 'room-1');
    expect(markdowns.length).toBe(1);
    expect(markdowns[0]).not.toContain('[sneaky](http://evil)');
    expect(markdowns[0]).toContain('@');
    expect(enqueuer.events.length).toBe(1);
  });

  it('message_agent from a room stays visible in the same room', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const before = (await store.list('conversations', { limit: 50 })).items.length;
    const result = await needTool(registry.get('message_agent'), 'message_agent').execute(
      { target: 'agent-b', message: 'Please double-check.' },
      ctxFor(store, enqueuer, 'agent-a', 'room-1'));
    expect(result.isError).not.toBe(true);
    const markdowns = await roomMarkdowns(store, 'room-1');
    expect(markdowns.some((m) => m.includes('Please double-check.') && m.includes('@Juno'))).toBe(true);
    expect(enqueuer.events.length).toBe(1);
    expect(enqueuer.events[0]?.conversationId).toBe('room-1');
    expect(enqueuer.events[0]?.sessionKey).toBe('agent-b:room-1');
    const after = (await store.list('conversations', { limit: 50 })).items.length;
    expect(after).toBe(before);
  });

  it('message_agent outside a room is refused: agents never talk privately', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const before = (await store.list('conversations', { limit: 50 })).items.length;
    const result = await needTool(registry.get('message_agent'), 'message_agent').execute(
      { target: 'agent-b', message: 'Private follow-up.' },
      ctxFor(store, enqueuer, 'agent-a', 'conv-a'));
    expect(result.isError).toBe(true);
    expect(enqueuer.events.length).toBe(0);
    expect((await store.list('conversations', { limit: 50 })).items.length).toBe(before);
    expect((await store.list('items', { limit: 50 })).items.length).toBe(0);
  });

  it('message_agent to self is rejected without side effects', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const result = await needTool(registry.get('message_agent'), 'message_agent').execute(
      { target: 'agent-a', message: 'Echo.' },
      ctxFor(store, enqueuer, 'agent-a', 'room-1'));
    expect(result.isError).toBe(true);
    expect(await roomMarkdowns(store, 'room-1')).toEqual([]);
    expect(enqueuer.events.length).toBe(0);
  });

  it('message_agent fails closed when the current conversation is missing', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const result = await needTool(registry.get('message_agent'), 'message_agent').execute(
      { target: 'agent-b', message: 'Must not become a private thread.' },
      ctxFor(store, enqueuer, 'agent-a', 'conv-ghost'));
    expect(result.isError).toBe(true);
    // No new conversation, no stored item and no wake: nothing routed privately.
    expect((await store.list('conversations', { limit: 50 })).items.length).toBe(2);
    expect((await store.list('items', { limit: 50 })).items.length).toBe(0);
    expect(enqueuer.events.length).toBe(0);
  });

  it('message_agent fails closed when the current conversation is unreadable', async () => {
    const broken: Store = { ...store, get: async () => { throw new Error('store down'); } };
    const registry = await createToolRegistry({ store: broken, enqueuer, config: {} });
    const result = await needTool(registry.get('message_agent'), 'message_agent').execute(
      { target: 'agent-b', message: 'Must not become a private thread.' },
      ctxFor(store, enqueuer, 'agent-a', 'room-1'));
    expect(result.isError).toBe(true);
    expect((await store.list('conversations', { limit: 50 })).items.length).toBe(2);
    expect((await store.list('items', { limit: 50 })).items.length).toBe(0);
    expect(enqueuer.events.length).toBe(0);
  });

  it('legacy post_to_room never targets self', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const result = await needTool(registry.get('post_to_room'), 'post_to_room').execute(
      { roomId: 'room-1', message: 'Self ping.', mentions: ['agent-a'] },
      ctxFor(store, enqueuer, 'agent-a', 'room-1'));
    expect(result.isError).toBe(true);
    expect(await roomMarkdowns(store, 'room-1')).toEqual([]);
    expect(enqueuer.events.length).toBe(0);
  });

  it('send_message with an explicit room id posts and wakes there, off the current conversation', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const result = await needTool(registry.get('send_message'), 'send_message').execute(
      { kind: 'text', text: 'Room update.', conversationId: 'room-1', targetAgentIds: ['agent-b'] },
      ctxFor(store, enqueuer, 'agent-a', 'conv-a'));
    expect(result.isError).not.toBe(true);
    expect(detailString(result, 'deliveredConversationId')).toBe('room-1');
    expect(await roomMarkdowns(store, 'conv-a')).toEqual([]);
    const markdowns = await roomMarkdowns(store, 'room-1');
    expect(markdowns.length).toBe(1);
    expect(markdowns[0]).toContain('Room update.');
    expect(markdowns[0]).toContain('@Juno');
    expect(enqueuer.events.length).toBe(1);
    expect(enqueuer.events[0]?.conversationId).toBe('room-1');
    expect(enqueuer.events[0]?.sessionKey).toBe('agent-b:room-1');
  });

  it('send_message with an explicit room and no targets posts a plain message with no wake', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const result = await needTool(registry.get('send_message'), 'send_message').execute(
      { kind: 'text', text: 'First message.', conversationId: 'room-1' },
      ctxFor(store, enqueuer, 'agent-a', 'conv-a'));
    expect(result.isError).not.toBe(true);
    expect(await roomMarkdowns(store, 'room-1')).toEqual(['First message.']);
    expect(enqueuer.events.length).toBe(0);
    expect(detailString(result, 'deliveredConversationId')).toBe('room-1');
  });

  it('send_message to a room the agent is not a member of is refused without writing', async () => {
    await store.put('conversations', {
      id: 'room-out', kind: 'room', title: 'Outside',
      agentIds: ['agent-b'], memberIds: [OWNER], unreadCount: 0, lastItemAt: NOW, createdAt: NOW,
    });
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const result = await needTool(registry.get('send_message'), 'send_message').execute(
      { kind: 'text', text: 'Hidden join.', conversationId: 'room-out', targetAgentIds: ['agent-b'] },
      ctxFor(store, enqueuer, 'agent-a', 'conv-a'));
    expect(result.isError).toBe(true);
    expect(await roomMarkdowns(store, 'room-out')).toEqual([]);
    expect(enqueuer.events.length).toBe(0);
  });

  it('send_message refuses an explicit conversationId that is not a room (room-only destination)', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const result = await needTool(registry.get('send_message'), 'send_message').execute(
      { kind: 'text', text: 'Wrong place.', conversationId: 'conv-a' },
      ctxFor(store, enqueuer, 'agent-a', 'conv-a'));
    expect(result.isError).toBe(true);
    expect(enqueuer.events.length).toBe(0);
  });

  it('a refused mention wake still posts the room message and marks the delivery', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    enqueuer.refuseNext = true;
    const result = await needTool(registry.get('send_message'), 'send_message').execute(
      { kind: 'text', text: 'Please verify.', targetAgentIds: ['agent-b'] },
      ctxFor(store, enqueuer, 'agent-a', 'room-1'));
    expect(result.isError).toBe(true);
    const markdowns = await roomMarkdowns(store, 'room-1');
    expect(markdowns.length).toBe(1);
    expect(markdowns[0]).toContain('Please verify.');
    expect(detailString(result, 'deliveredText')).toBe(markdowns[0]);
    expect(detailString(result, 'deliveredConversationId')).toBe('room-1');
    expect(enqueuer.events.length).toBe(0);
  });

  it('send_message rejects blank text without writing or marking a delivery', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const send = needTool(registry.get('send_message'), 'send_message');
    const plain = await send.execute({ kind: 'text', text: '   \n  ' }, ctxFor(store, enqueuer, 'agent-a', 'room-1'));
    const targeted = await send.execute(
      { kind: 'text', text: '  ', targetAgentIds: ['agent-b'] },
      ctxFor(store, enqueuer, 'agent-a', 'room-1'));
    expect(plain.isError).toBe(true);
    expect(targeted.isError).toBe(true);
    // No deliveredText marker: a blank post must never suppress the useful final report.
    expect(plain.details?.deliveredText).toBeUndefined();
    expect(targeted.details?.deliveredText).toBeUndefined();
    expect(await roomMarkdowns(store, 'room-1')).toEqual([]);
    expect(enqueuer.events.length).toBe(0);
  });

  it('send_message rejects a blank question without creating a request', async () => {
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const result = await needTool(registry.get('send_message'), 'send_message').execute(
      { kind: 'question', text: '   ' },
      ctxFor(store, enqueuer, 'agent-a', 'room-1'));
    expect(result.isError).toBe(true);
    expect(result.suspend).toBeUndefined();
    expect((await store.list('requests', { limit: 10 })).items.length).toBe(0);
  });

  it('send_message run attribution carries trusted ctx runId in plain and targeted room delivery', async () => {
    const emitted: Array<Parameters<Store['emit']>[0]> = [];
    const origEmit = store.emit.bind(store);
    store.emit = async (event) => {
      emitted.push(event);
      return origEmit(event);
    };
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const send = needTool(registry.get('send_message'), 'send_message');
    const plain = await send.execute(
      { kind: 'text', text: 'Plain bubble.' },
      ctxFor(store, enqueuer, 'agent-a', 'room-1'));
    expect(plain.isError).not.toBe(true);
    const targeted = await send.execute(
      { kind: 'text', text: 'Room nudge.', targetAgentIds: ['agent-b'], runId: 'spoofed-run' },
      ctxFor(store, enqueuer, 'agent-a', 'room-1'));
    expect(targeted.isError).not.toBe(true);
    const stored = (await store.list('items', { limit: 100 })).items;
    const plainItem = stored.find((item) => item.type === 'agent_message' && item.markdown === 'Plain bubble.');
    const roomItem = stored.find((item) => item.type === 'agent_message' && item.markdown.includes('Room nudge.'));
    if (plainItem?.type !== 'agent_message' || roomItem?.type !== 'agent_message') {
      throw new Error('expected both plain and targeted bubbles to be stored');
    }
    expect(plainItem.runId).toBe('run-1');
    expect(roomItem.runId).toBe('run-1');
    const indexed = await store.list('items', { limit: 100, where: { runId: 'run-1' } });
    expect(indexed.items.length).toBe(2);
    const added = emitted.filter((event) => event.type === 'item.added');
    expect(added.length).toBe(2);
    for (const event of added) {
      if (event.type !== 'item.added' || event.item.type !== 'agent_message') {
        throw new Error('expected item.added agent_message events');
      }
      expect(event.item.runId).toBe('run-1');
    }
  });
});

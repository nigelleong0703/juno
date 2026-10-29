/**
 * handoff with memoryRefs (BACKEND 6.1b): the receiver's wake carries the items both runs may read, labelled; the sender's result says how
 * many went along and how many were left out. Embedded Postgres for the items, the in-memory store for the rest.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Enqueuer, Store, ToolContext, ToolResult, WakeEvent } from '../../../contracts/index.js';
import { createMemoryStore } from '../../../testing/store.js';
import { portOf, startMemoryGraph, type MemoryGraphFixture } from '../../memory/__tests__/memory-graph-fixture.js';
import { createToolRegistry } from '../index.js';

let fixture: MemoryGraphFixture;

beforeAll(async () => {
  fixture = await startMemoryGraph();
});

afterAll(async () => {
  await fixture.close();
});

class RecordingEnqueuer implements Enqueuer {
  events: WakeEvent[] = [];
  async enqueue(event: WakeEvent) {
    this.events.push(event);
    return { accepted: true };
  }
  async stopRun() {}
  async resolveAwakeable() {}
  async scheduleRoutine() {}
}

function textOf(result: ToolResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

describe('handoff with memoryRefs', () => {
  it('passes the items both may read, labelled, in the wake; reports what was left out', async () => {
    const owner = 'owner-refs-' + randomUUID();
    const store: Store = createMemoryStore();
    await store.put('agents', { id: 'agent-a', name: 'Mint', ownerId: owner, createdAt: '2026-10-01T00:00:00Z' } as never);
    await store.put('agents', { id: 'agent-b', name: 'Atlas', ownerId: owner, createdAt: '2026-10-01T00:00:00Z' } as never);
    await store.put('conversations', { id: 'room-1', kind: 'room', title: 'Team', agentIds: ['agent-a', 'agent-b'], memberIds: [owner], ownerId: owner, createdAt: '2026-10-01T00:00:00Z' } as never);
    await store.put('conversations', { id: 'conv-a', kind: 'direct', agentIds: ['agent-a'], memberIds: [owner], ownerId: owner, createdAt: '2026-10-01T00:00:00Z' } as never);
    const { items } = fixture.graph;
    const shared = await items.addItem(owner, { text: 'Owner likes lentils.', kind: 'preference', file: 'bank:preferences', saidIn: 'app', audience: 'owner' });
    const hers = await items.addItem(owner, { text: 'Atlas keeps the flight log.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner', agentId: 'agent-b' });
    if (shared === null || hers === null) throw new Error('fixture items were not written');

    const enqueuer = new RecordingEnqueuer();
    const registry = await createToolRegistry({ store, enqueuer, config: {}, memory: portOf(fixture, store) });
    const tool = registry.get('handoff');
    if (tool === undefined) throw new Error('handoff tool missing');
    const wake: WakeEvent = {
      id: 'wke-1', ownerId: owner, agentId: 'agent-a', sessionKey: 'agent-a:conv-a', conversationId: 'conv-a', kind: 'user_message',
      origin: { type: 'user', id: owner }, trusted: true, priority: 'user', payload: { text: 'hi' }, at: '2026-10-26T00:00:00Z', status: 'accepted',
    };
    const ctx = {
      ownerId: owner, agentId: 'agent-a', conversationId: 'conv-a', runId: 'run-1', store, enqueuer, wake,
      step: async (_name: string, fn: () => Promise<unknown>) => fn(), signal: new AbortController().signal,
    } as unknown as ToolContext;

    const result = await tool.execute({ roomId: 'room-1', to: 'agent-b', task: 'Plan my meals.', memoryRefs: [shared.id, hers.id, 'mem_missing'] }, ctx);
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain('1 memory item went along; 2 memory refs left out');
    const sent = enqueuer.events[0];
    expect(sent?.agentId).toBe('agent-b');
    const text = typeof sent?.payload['text'] === 'string' ? sent.payload['text'] : '';
    expect(text.startsWith('Plan my meals.')).toBe(true);
    expect(text).toContain('Owner likes lentils.');
    expect(text).not.toContain('Atlas keeps the flight log.');
    expect(text).toContain('<untrusted>');
  });

  it('without memoryRefs the wake carries the task alone', async () => {
    const owner = 'owner-noref-' + randomUUID();
    const store: Store = createMemoryStore();
    await store.put('agents', { id: 'agent-a', name: 'Mint', ownerId: owner, createdAt: '2026-10-01T00:00:00Z' } as never);
    await store.put('agents', { id: 'agent-b', name: 'Atlas', ownerId: owner, createdAt: '2026-10-01T00:00:00Z' } as never);
    await store.put('conversations', { id: 'room-2', kind: 'room', title: 'Team', agentIds: ['agent-a', 'agent-b'], memberIds: [owner], ownerId: owner, createdAt: '2026-10-01T00:00:00Z' } as never);
    const enqueuer = new RecordingEnqueuer();
    const registry = await createToolRegistry({ store, enqueuer, config: {} });
    const tool = registry.get('handoff');
    if (tool === undefined) throw new Error('handoff tool missing');
    const ctx = {
      ownerId: owner, agentId: 'agent-a', conversationId: 'room-2', runId: 'run-2', store, enqueuer,
      wake: { id: 'wke-2', ownerId: owner, agentId: 'agent-a', sessionKey: 'agent-a:room-2', conversationId: 'room-2', kind: 'user_message', origin: { type: 'user', id: owner }, trusted: true, priority: 'user', payload: { text: 'hi' }, at: '2026-10-26T00:00:00Z', status: 'accepted' },
      step: async (_name: string, fn: () => Promise<unknown>) => fn(), signal: new AbortController().signal,
    } as unknown as ToolContext;
    const result = await tool.execute({ roomId: 'room-2', to: 'agent-b', task: 'Say hello.' }, ctx);
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).not.toContain('memory');
    expect(enqueuer.events[0]?.payload['text']).toBe('Say hello.');
  });
});

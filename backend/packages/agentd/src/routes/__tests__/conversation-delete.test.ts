/** Deleting one conversation removes everything that belongs to it, only for its owner, and keeps audit rows. */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Collection, Enqueuer, Store, WakeEvent } from '@agent-desktop/contracts';
import { registerAgents } from '../agents.js';
import { registerConversations } from '../conversations.js';
import { testChannels } from '../../__tests__/test-app.js';

const OWNER = 'owner-1';
const OTHER = 'owner-2';
const at = '2026-10-06T00:00:00.000Z';
const usage = { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 };

class OrphanEnqueuer implements Enqueuer {
  async enqueue(event: WakeEvent): Promise<{ accepted: boolean }> {
    void event;
    return { accepted: true };
  }
  async stopRun(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
  async resolveAwakeable(): Promise<void> {}
  /** No workflow behind any run, so a stop finalizes the row inline. */
  async runState(): Promise<'none'> {
    return 'none';
  }
}

function appFor(mem: ReturnType<typeof createMemoryStore>, owner: string): Hono {
  const app = new Hono();
  app.use('*', async (c: Context, next) => {
    c.set('ownerId', owner);
    await next();
  });
  registerConversations(app, { store: mem, bus: mem.eventBus, enqueuer: new OrphanEnqueuer(), channels: testChannels });
  return app;
}

async function seed(store: Store, convId: string, agentId: string, runStatus: 'completed' | 'running'): Promise<void> {
  await store.put('conversations', { id: convId, kind: 'direct', agentIds: [agentId], memberIds: [OWNER], unreadCount: 0, lastItemAt: at, createdAt: at });
  await store.put('items', { id: 'itm-' + convId, conversationId: convId, type: 'user_message', authorId: OWNER, text: 'hi', attachments: [], mentions: [], at }, { conversationId: convId });
  await store.put('runs', { id: 'run-' + convId, agentId, conversationId: convId, title: 't', status: runStatus, kind: 'chat', steps: [], usage, startedAt: at, lastActivityAt: at }, { agentId, conversationId: convId, status: runStatus });
  await store.put('browserGoalGates', { id: 'bg-' + convId, ownerId: OWNER, agentId, conversationId: convId, runId: 'run-' + convId, stageId: 'stp-' + convId, goal: 'Edit profile', completion: [{ match: { label: 'Nickname' }, property: 'value', equals: 'Mira' }], on: 'sandbox', status: 'pending', updatedAt: at });
  await store.put('steps', { id: 'stp-' + convId, runId: 'run-' + convId, index: 0, kind: 'shell', verb: 'v', target: 't', status: 'completed', startedAt: at, durationMs: 1 }, { runId: 'run-' + convId });
  await store.put('requests', { id: 'req-' + convId, kind: 'question', status: 'pending', title: 'q', summary: 's', agentId, conversationId: convId, createdAt: at, payload: { kind: 'question', ui: { version: 1, blocks: [{ type: 'fields', id: 'form', fields: [{ id: 'f', label: 'q', kind: 'text' }] }] } } }, { conversationId: convId });
  for (const key of [agentId + ':' + convId, agentId + ':' + convId + '::child:run-x']) {
    await store.put('transcripts', { id: 'tx-' + key, sessionKey: key, seq: 0, message: { role: 'user', content: 'x' }, compactionEpoch: 0, at });
  }
  await store.put('audit', { id: 'aud-' + convId, at, actor: 'agent', agentId, action: 'tool.policy', decision: 'auto_allowed', reason: 'r', initiator: { type: 'owner_message', conversationId: convId }, unattended: false }, { conversationId: convId });
}

describe('conversation delete cascade', () => {
  it('removes the chat, its runs, steps, requests and transcripts (child sessions too), keeps audit and other chats', async () => {
    const mem = createMemoryStore();
    const store = mem.forOwner?.(OWNER);
    if (!store) throw new Error('memory store is missing forOwner');
    await seed(store, 'cvn-a', 'agt-1', 'completed');
    await seed(store, 'cvn-b', 'agt-1', 'completed');

    expect((await appFor(mem, OTHER).request('/v1/conversations/cvn-a', { method: 'DELETE' })).status).toBe(404);
    expect(await store.get('conversations', 'cvn-a')).not.toBeNull();

    expect((await appFor(mem, OWNER).request('/v1/conversations/cvn-a', { method: 'DELETE' })).status).toBe(200);
    const gone: Array<[Collection, string]> = [['browserGoalGates', 'bg-cvn-a'], ['conversations', 'cvn-a'], ['items', 'itm-cvn-a'], ['runs', 'run-cvn-a'], ['steps', 'stp-cvn-a'], ['requests', 'req-cvn-a'], ['transcripts', 'tx-agt-1:cvn-a'], ['transcripts', 'tx-agt-1:cvn-a::child:run-x']];
    for (const [collection, id] of gone) expect(await store.get(collection, id)).toBeNull();
    expect(await store.get('audit', 'aud-cvn-a')).not.toBeNull();
    const kept: Array<[Collection, string]> = [['browserGoalGates', 'bg-cvn-b'], ['conversations', 'cvn-b'], ['items', 'itm-cvn-b'], ['runs', 'run-cvn-b'], ['steps', 'stp-cvn-b'], ['requests', 'req-cvn-b'], ['transcripts', 'tx-agt-1:cvn-b']];
    for (const [collection, id] of kept) expect(await store.get(collection, id)).not.toBeNull();
    const deleted = (await mem.eventBus.since(0, 100)).filter((e) => e.event.type === 'conversation.deleted');
    expect(deleted).toHaveLength(1);
    expect((await appFor(mem, OWNER).request('/v1/conversations/cvn-a', { method: 'DELETE' })).status).toBe(404);
  });

  it('deleting an agent also removes its goals and ideas, not another agent\'s', async () => {
    const mem = createMemoryStore();
    const store = mem.forOwner?.(OWNER);
    if (!store) throw new Error('memory store is missing forOwner');
    const app = appFor(mem, OWNER);
    registerAgents(app, { store: mem, bus: mem.eventBus, enqueuer: new OrphanEnqueuer(), channels: testChannels });
    const created: unknown = await (await app.request('/v1/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'A' }) })).json();
    const id = typeof created === 'object' && created !== null && 'id' in created && typeof created.id === 'string' ? created.id : '';
    for (const agentId of [id, 'agt-2']) {
      await store.put('goals', { id: 'goal-' + agentId, agentId, kind: 'goal', title: 't', summary: 's', status: 'active', createdAt: at, updatedAt: at });
      await store.put('ideas', { id: 'idea-' + agentId, agentId, text: 't', prompt: 'p', status: 'open', createdAt: at, updatedAt: at });
    }
    expect((await app.request('/v1/agents/' + id, { method: 'DELETE' })).status).toBe(200);
    expect(await store.get('goals', 'goal-' + id)).toBeNull();
    expect(await store.get('ideas', 'idea-' + id)).toBeNull();
    expect(await store.get('goals', 'goal-agt-2')).not.toBeNull();
    expect(await store.get('ideas', 'idea-agt-2')).not.toBeNull();
  });

});

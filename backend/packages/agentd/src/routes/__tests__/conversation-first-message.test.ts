import { aguiInput } from '../../../../../tests/agui-input.js';
/**
 * UX2: POST /v1/conversations used to accept but silently drop `firstMessage`. It must now
 * admit the message through the same pipeline as POST /v1/conversations/:id/messages.
 * Pins: canonical payload validation before any write (no orphan conversation), one stored
 * user_message plus its event, exactly one wake per target, mention/attachment persistence,
 * and refusal to acknowledge a message whose durable wake was rejected.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Item } from '@agent-desktop/public-contracts';
import type { Store, WakeEvent } from '@agent-desktop/contracts';
import type { Agent } from '@agent-desktop/public-contracts';
import { createTestApp, ownerHeaders, withDefaultOwner } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';

const OWNER = getConfig().OWNER_ID;

type UserMessageItem = Extract<Item, { type: 'user_message' }>;

class RecordingEnqueuer {
  wakes: WakeEvent[] = [];
  accepted = true;
  throwOnEnqueue = false;

  async enqueue(event: WakeEvent): Promise<{ accepted: boolean; reason?: string }> {
    this.wakes.push(event);
    if (this.throwOnEnqueue) throw new Error('restate connection reset');
    if (this.accepted) return { accepted: true };
    return { accepted: false, reason: 'restate unavailable' };
  }

  async stopRun(): Promise<void> {}
  async resolveAwakeable(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
}

function makeAgent(id: string, extra: Partial<Agent> = {}): Agent {
  return {
    id,
    name: 'Agent ' + id,
    handle: id,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'Test agent',
    status: 'idle',
    section: 'Inbox',
    pinned: false,
    lastActivity: 'Just created',
    unreadCount: 0,
    model: {
      planner: { provider: 'openai', model: 'gpt-4' },
      computer: { provider: 'openai', model: 'gpt-4-vision' },
      fast: { provider: 'openai', model: 'gpt-3.5-turbo' },
    },
    channels: [],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

function userMessages(items: Item[]): UserMessageItem[] {
  const found: UserMessageItem[] = [];
  for (const item of items) if (item.type === 'user_message') found.push(item);
  return found;
}

function stringField(body: unknown, key: string): string {
  if (typeof body !== 'object' || body === null) throw new Error('expected object body');
  const value: unknown = (body as Record<string, unknown>)[key];
  if (typeof value !== 'string') throw new Error('expected string field ' + key);
  return value;
}

function errorCodeOf(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const error: unknown = (body as Record<string, unknown>)['error'];
  if (typeof error !== 'object' || error === null) return '';
  const code: unknown = (error as Record<string, unknown>)['code'];
  return typeof code === 'string' ? code : '';
}

describe('conversation firstMessage admission', () => {
  let store: Store;
  let app: Hono;
  let enqueuer: RecordingEnqueuer;
  let mem: ReturnType<typeof createMemoryStore>;

  async function call(
    path: string,
    method: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: { ...ownerHeaders(getConfig().OWNER_ID), 'Content-Type': 'application/json', ...headers },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return app.request(path, init);
  }

  beforeEach(async () => {
    mem = createMemoryStore();
    store = withDefaultOwner(mem, getConfig().OWNER_ID);
    enqueuer = new RecordingEnqueuer();
    app = createTestApp({ store, bus: mem.eventBus, enqueuer });
    await store.put('agents', makeAgent('agt-a', { createdBy: OWNER }));
    await store.put('agents', makeAgent('agt-b', { createdBy: OWNER }));
  });

  it('stores the first message with its event and wakes the agent exactly once', async () => {
    await store.put('library', { id: 'att-1', name: 'notes.txt', kind: 'file', mimeType: 'text/plain', sizeBytes: 5, source: 'upload', ownerId: OWNER, createdAt: new Date().toISOString() } as never);
    const res = await call('/v1/conversations', 'POST', {
      kind: 'direct',
      memberAgentIds: ['agt-a'],
      firstMessage: {
        text: 'hello',
        attachments: [{ id: 'att-1', name: 'notes.txt', kind: 'file' }],
        mentions: [{ kind: 'agent', id: 'agt-a', label: '@Agent agt-a' }],
      },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const convId = stringField(await res.json(), 'id');

    const stored = userMessages((await store.list('items', { where: { conversationId: convId } })).items);
    expect(stored).toHaveLength(1);
    const first = stored[0];
    if (!first) throw new Error('first message not stored');
    expect(first.text).toBe('hello');
    expect(first.attachments.map((a) => a.id)).toEqual(['att-1']);
    expect(first.mentions.map((m) => m.id)).toEqual(['agt-a']);
    expect(first.authorId).toBe(OWNER);

    expect(enqueuer.wakes).toHaveLength(1);
    const wake = enqueuer.wakes[0];
    if (!wake) throw new Error('wake not enqueued');
    expect(wake.agentId).toBe('agt-a');
    expect(wake.conversationId).toBe(convId);
    expect(wake.sessionKey).toBe('agt-a:' + convId);
    expect(wake.payload.text).toBe('hello');
    expect(wake.ownerId).toBe(OWNER);
    expect(wake.id).toBe('wk-' + first.id + '-agt-a');

    const events = (await mem.eventBus.since(0)).map((e) => e.event.type);
    expect(events).toContain('conversation.created');
    expect(events.filter((type) => type === 'item.added')).toHaveLength(1);
  });

  it('refuses an attachment that was never uploaded before any write', async () => {
    const res = await call('/v1/conversations', 'POST', {
      kind: 'direct',
      memberAgentIds: ['agt-a'],
      firstMessage: { text: '', attachments: [{ id: 'resume.pdf-86776-0', name: 'resume.pdf', kind: 'file' }] },
    });
    expect(res.status).toBe(400);
    expect(errorCodeOf(await res.json())).toBe('ATTACHMENT_NOT_FOUND');
    expect((await store.list('conversations')).items).toHaveLength(0);
    expect((await store.list('items')).items).toHaveLength(0);
    expect(enqueuer.wakes).toHaveLength(0);
  });

  it('rejects an invalid firstMessage before any write, leaving no orphan conversation', async () => {
    const res = await call('/v1/conversations', 'POST', {
      kind: 'direct',
      memberAgentIds: ['agt-a'],
      firstMessage: { text: 42 },
    });
    expect(res.status).toBe(400);
    expect(errorCodeOf(await res.json())).toBe('INVALID_MESSAGE');
    expect((await store.list('conversations')).items).toHaveLength(0);
    expect((await store.list('items')).items).toHaveLength(0);
    expect(enqueuer.wakes).toHaveLength(0);
  });

  it('rejects a firstMessage mention outside the room without creating the conversation', async () => {
    const res = await call('/v1/conversations', 'POST', {
      kind: 'room',
      memberAgentIds: ['agt-a'],
      firstMessage: { text: 'hi', mentions: [{ kind: 'agent', id: 'agt-outsider', label: '@outsider' }] },
    });
    expect(res.status).toBe(400);
    expect(errorCodeOf(await res.json())).toBe('MENTION_NOT_MEMBER');
    expect((await store.list('conversations')).items).toHaveLength(0);
    expect(enqueuer.wakes).toHaveLength(0);
  });

  it('does not wake any room member for an un-mentioned first message (mention-only rooms)', async () => {
    const res = await call('/v1/conversations', 'POST', {
      kind: 'room',
      memberAgentIds: ['agt-a', 'agt-b'],
      roomMode: 'open_floor',
      firstMessage: { text: 'sync up' },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const convId = stringField(await res.json(), 'id');
    expect(userMessages((await store.list('items', { where: { conversationId: convId } })).items)).toHaveLength(1);
    expect(enqueuer.wakes).toHaveLength(0);
  });

  it('wakes only the explicitly mentioned room member for a first message', async () => {
    const res = await call('/v1/conversations', 'POST', {
      kind: 'room',
      memberAgentIds: ['agt-a', 'agt-b'],
      firstMessage: { text: 'ping @agt-a', mentions: [{ kind: 'agent', id: 'agt-a', label: '@Agent agt-a' }] },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const convId = stringField(await res.json(), 'id');
    expect(enqueuer.wakes.map((w) => w.agentId)).toEqual(['agt-a']);
    expect(enqueuer.wakes[0]?.conversationId).toBe(convId);
    expect(enqueuer.wakes[0]?.mode).toBe('steer');
  });

  it('does not acknowledge a message when the durable wake is rejected', async () => {
    enqueuer.accepted = false;
    const create = await call('/v1/conversations', 'POST', {
      kind: 'direct',
      memberAgentIds: ['agt-a'],
      firstMessage: { text: 'hi' },
    });
    expect(create.status).toBe(503);
    expect(errorCodeOf(await create.json())).toBe('WAKE_ENQUEUE_FAILED');
    expect(enqueuer.wakes).toHaveLength(1);

    enqueuer.accepted = true;
    const made = await call('/v1/conversations', 'POST', { kind: 'direct', memberAgentIds: ['agt-a'] });
    const convId = stringField(await made.json(), 'id');
    enqueuer.accepted = false;
    const send = await call('/v1/conversations/' + convId + '/runs', 'POST', aguiInput('/v1/conversations/' + convId + '/runs', { text: 'again' }));
    expect(send.status).toBe(503);
    expect(errorCodeOf(await send.json())).toBe('WAKE_ENQUEUE_FAILED');
  });

  it('surfaces a thrown enqueue as a non-success acknowledgment', async () => {
    enqueuer.throwOnEnqueue = true;
    const create = await call('/v1/conversations', 'POST', {
      kind: 'direct',
      memberAgentIds: ['agt-a'],
      firstMessage: { text: 'hi' },
    });
    expect(create.status).toBe(503);
    expect(errorCodeOf(await create.json())).toBe('WAKE_ENQUEUE_FAILED');

    enqueuer.throwOnEnqueue = false;
    const made = await call('/v1/conversations', 'POST', { kind: 'direct', memberAgentIds: ['agt-a'] });
    const convId = stringField(await made.json(), 'id');
    enqueuer.throwOnEnqueue = true;
    const send = await call('/v1/conversations/' + convId + '/runs', 'POST', aguiInput('/v1/conversations/' + convId + '/runs', { text: 'again' }));
    expect(send.status).toBe(503);
  });

  it('replays a keyed create to the same conversation and wake id instead of duplicating', async () => {
    enqueuer.accepted = false;
    const first = await call(
      '/v1/conversations',
      'POST',
      { kind: 'direct', memberAgentIds: ['agt-a'], firstMessage: { text: 'hi' } },
      { 'Idempotency-Key': 'start-1' },
    );
    expect(first.status).toBe(503);
    expect(enqueuer.wakes).toHaveLength(1);
    const firstWakeId = enqueuer.wakes[0]?.id;

    enqueuer.accepted = true;
    const retry = await call(
      '/v1/conversations',
      'POST',
      { kind: 'direct', memberAgentIds: ['agt-a'], firstMessage: { text: 'hi' } },
      { 'Idempotency-Key': 'start-1' },
    );
    expect(retry.status, await retry.clone().text()).toBe(201);
    const convId = stringField(await retry.json(), 'id');
    const conversations = (await store.list('conversations')).items;
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.id).toBe(convId);
    expect(userMessages((await store.list('items', { where: { conversationId: convId } })).items)).toHaveLength(1);
    expect(enqueuer.wakes).toHaveLength(2);
    expect(enqueuer.wakes[1]?.id).toBe(firstWakeId);
    const events = (await mem.eventBus.since(0)).map((e) => e.event.type);
    expect(events.filter((type) => type === 'conversation.created')).toHaveLength(1);
    expect(events.filter((type) => type === 'item.added')).toHaveLength(1);
  });

  it('reuses the stored message for a body requestId replay and refuses a changed payload', async () => {
    const body = {
      kind: 'direct',
      memberAgentIds: ['agt-a'],
      requestId: 'req-body-1',
      firstMessage: { text: 'original' },
    };
    const first = await call('/v1/conversations', 'POST', body);
    expect(first.status, await first.clone().text()).toBe(201);
    const convId = stringField(await first.json(), 'id');
    expect(enqueuer.wakes).toHaveLength(1);
    const firstWakeId = enqueuer.wakes[0]?.id;

    const replay = await call('/v1/conversations', 'POST', body);
    expect(replay.status).toBe(201);
    expect(stringField(await replay.json(), 'id')).toBe(convId);
    expect((await store.list('conversations')).items).toHaveLength(1);
    expect(enqueuer.wakes).toHaveLength(2);
    expect(enqueuer.wakes[1]?.id).toBe(firstWakeId);
    expect(enqueuer.wakes[1]?.payload.text).toBe('original');

    const conflict = await call('/v1/conversations', 'POST', {
      kind: 'direct',
      memberAgentIds: ['agt-a'],
      requestId: 'req-body-1',
      firstMessage: { text: 'changed' },
    });
    expect(conflict.status).toBe(409);
    expect(errorCodeOf(await conflict.json())).toBe('REQUEST_ID_CONFLICT');
    expect(enqueuer.wakes).toHaveLength(2);
    const stored = userMessages((await store.list('items', { where: { conversationId: convId } })).items);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.text).toBe('original');
  });

  it('E64: admits only one of two concurrent creates that reuse a requestId', async () => {
    const make = (text: string) =>
      call('/v1/conversations', 'POST', { kind: 'direct', memberAgentIds: ['agt-a'], requestId: 'req-race', firstMessage: { text } });
    const responses = await Promise.all([make('first'), make('second')]);
    const statuses = responses.map((res) => res.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect((await store.list('conversations')).items).toHaveLength(1);
    const convId = (await store.list('conversations')).items[0]?.id ?? '';
    const stored = userMessages((await store.list('items', { where: { conversationId: convId } })).items);
    expect(stored).toHaveLength(1);
    expect(enqueuer.wakes).toHaveLength(1);
    expect(enqueuer.wakes[0]?.payload.text).toBe(stored[0]?.text);
  });

  it('rejects a requestId that disagrees with the Idempotency-Key header', async () => {
    const res = await call(
      '/v1/conversations',
      'POST',
      { kind: 'direct', memberAgentIds: ['agt-a'], requestId: 'a' },
      { 'Idempotency-Key': 'b' },
    );
    expect(res.status).toBe(400);
    expect(errorCodeOf(await res.json())).toBe('REQUEST_ID_MISMATCH');
    expect((await store.list('conversations')).items).toHaveLength(0);
  });

  it('keeps POST messages behavior: 202 acknowledgment, stored item and one wake', async () => {
    const made = await call('/v1/conversations', 'POST', { kind: 'room', memberAgentIds: ['agt-a', 'agt-b'] });
    const convId = stringField(await made.json(), 'id');
    const res = await call('/v1/conversations/' + convId + '/runs', 'POST', aguiInput('/v1/conversations/' + convId + '/runs', {
      text: 'ping',
      mentions: [{ kind: 'agent', id: 'agt-b', label: '@Agent agt-b' }],
    }));
    expect(res.status).toBe(202);
    expect(enqueuer.wakes.map((w) => w.agentId)).toEqual(['agt-b']);
    expect(userMessages((await store.list('items', { where: { conversationId: convId } })).items)).toHaveLength(1);
  });
});

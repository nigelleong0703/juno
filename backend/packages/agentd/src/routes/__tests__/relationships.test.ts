import { aguiInput } from '../../../../../tests/agui-input.js';
/**
 * RA1 relationship API: ownership validation, membership-based listing,
 * host and mention policy, and the canonical agent-visibility precedence.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { type Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Store, WakeEvent } from '@agent-desktop/contracts';
import type { Agent, Conversation } from '@agent-desktop/public-contracts';
import { createTestApp, ownerHeaders, withDefaultOwner } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';
import { listAll } from '../relationships.js';

const OWNER = getConfig().OWNER_ID;
const OTHER = 'member-other-owner';

class RecordingEnqueuer {
  wakes: WakeEvent[] = [];
  async enqueue(event: WakeEvent): Promise<{ accepted: boolean }> {
    this.wakes.push(event);
    return { accepted: true };
  }
  async stopRun(runId: string): Promise<void> {
    void runId;
  }
  async resolveAwakeable(awakeableId: string, value: unknown): Promise<void> {
    void awakeableId;
    void value;
  }
  async scheduleRoutine(routineId: string): Promise<void> {
    void routineId;
  }
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

function makeConversation(id: string, agentIds: string[], owner: string): Conversation & { ownerId: string } {
  const now = new Date().toISOString();
  return {
    id,
    kind: 'direct',
    agentIds,
    memberIds: [owner],
    unreadCount: 0,
    lastItemAt: now,
    createdAt: now,
    ownerId: owner,
  };
}

function asRecord(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) record[key] = value;
  return record;
}

function stringField(body: unknown, key: string): string {
  const record = asRecord(body);
  if (!record) throw new Error('expected object body');
  const value: unknown = record[key];
  if (typeof value !== 'string') throw new Error('expected string field ' + key);
  return value;
}

function optionalStringField(body: unknown, key: string): string | undefined {
  const record = asRecord(body);
  if (!record) throw new Error('expected object body');
  const value: unknown = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('expected string field ' + key);
  return value;
}

function stringArrayField(body: unknown, key: string): string[] {
  const record = asRecord(body);
  if (!record) throw new Error('expected object body');
  const value: unknown = record[key];
  if (!Array.isArray(value)) throw new Error('expected array field ' + key);
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error('expected string entries in ' + key);
    ids.push(entry);
  }
  return ids;
}

function itemIds(body: unknown): string[] {
  const record = asRecord(body);
  if (!record) throw new Error('expected object body');
  const items: unknown = record['items'];
  if (!Array.isArray(items)) throw new Error('expected items array');
  const ids: string[] = [];
  for (const entry of items) {
    const entryRecord = asRecord(entry);
    if (!entryRecord) throw new Error('expected object entry');
    const id: unknown = entryRecord['id'];
    if (typeof id !== 'string') throw new Error('expected string entry id');
    ids.push(id);
  }
  return ids;
}

describe('relationship API', () => {
  let store: Store;
  let app: Hono;
  let enqueuer: RecordingEnqueuer;

  async function call(path: string, method: string, body?: unknown): Promise<Response> {
    const init: RequestInit = { method, headers: { ...ownerHeaders(getConfig().OWNER_ID), 'Content-Type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    return app.request(path, init);
  }

  async function seedAgent(id: string, extra: Partial<Agent> = {}, owner?: string): Promise<void> {
    const agent = makeAgent(id, extra);
    if (owner === undefined) {
      await store.put('agents', agent);
      return;
    }
    const owned: Agent & { ownerId: string } = { ...agent, ownerId: owner };
    await store.put('agents', owned);
  }

  beforeEach(async () => {
    const mem = createMemoryStore();
    store = withDefaultOwner(mem, getConfig().OWNER_ID);
    enqueuer = new RecordingEnqueuer();
    app = createTestApp({ store, bus: mem.eventBus, enqueuer });
  });

  describe('agent creation', () => {
    it('persists owner and creator', async () => {
      const res = await call('/v1/agents', 'POST', { name: 'Solo' });
      expect(res.status).toBe(201);
      const createdId = stringField(await res.json(), 'id');
      const agent = await store.get('agents', createdId);
      expect(agent?.createdBy).toBe(OWNER);
    });
  });

  describe('agent visibility precedence', () => {
    it('foreign recorded owner is not overridden by createdBy (404: never revealed)', async () => {
      await seedAgent('agt-foreign', { createdBy: OWNER }, OTHER);
      const res = await call('/v1/agents/agt-foreign', 'GET');
      expect(res.status).toBe(404);
    });

    // Team sharing (owner decision 2026-10-12: option B) is not implemented in production yet; this is its
    // acceptance test (MUSE-PARITY 待办 I-05).
    it('unknown owner without creator fails closed (an ownerless legacy row is invisible)', async () => {
      await seedAgent('agt-stray', {}, 'unknown');
      const res = await call('/v1/agents/agt-stray', 'GET');
      expect(res.status).toBe(404);
    });

    it('creator fallback works only when no owner is recorded', async () => {
      await seedAgent('agt-mine', { createdBy: OWNER });
      const res = await call('/v1/agents/agt-mine', 'GET');
      expect(res.status).toBe(200);
    });
  });

  describe('conversation creation', () => {
    it('creates a direct conversation owned by the requester', async () => {
      await seedAgent('agt-a', { createdBy: OWNER }, OWNER);
      const res = await call('/v1/conversations', 'POST', { kind: 'direct', memberAgentIds: ['agt-a'] });
      expect(res.status).toBe(201);
    });

    it('rejects missing and cross-owner members', async () => {
      await seedAgent('agt-a', { createdBy: OWNER }, OWNER);
      await seedAgent('agt-b', { createdBy: OWNER }, OWNER);
      await seedAgent('agt-other', { createdBy: OTHER }, OTHER);
      const missing = await call('/v1/conversations', 'POST', { kind: 'room', memberAgentIds: ['agt-a', 'missing-agent'] });
      expect(missing.status).toBe(404);
      const crossOwner = await call('/v1/conversations', 'POST', { kind: 'room', memberAgentIds: ['agt-a', 'agt-other'] });
      expect(crossOwner.status).toBe(404);
      const ok = await call('/v1/conversations', 'POST', { kind: 'room', memberAgentIds: ['agt-a', 'agt-b'] });
      expect(ok.status).toBe(201);
    });

    it('collapses duplicate member ids and validates the host', async () => {
      await seedAgent('agt-a', { createdBy: OWNER }, OWNER);
      await seedAgent('agt-b', { createdBy: OWNER }, OWNER);
      const dupes = await call('/v1/conversations', 'POST', { kind: 'room', memberAgentIds: ['agt-a', 'agt-a'] });
      expect(dupes.status).toBe(201);
      expect(stringArrayField(await dupes.json(), 'agentIds')).toEqual(['agt-a']);
      const badHost = await call('/v1/conversations', 'POST', { kind: 'room', memberAgentIds: ['agt-a'], hostAgentId: 'agt-b' });
      expect(badHost.status).toBe(400);
      const noHost = await call('/v1/conversations', 'POST', { kind: 'room', memberAgentIds: ['agt-a'] });
      expect(noHost.status).toBe(201);
      expect(optionalStringField(await noHost.json(), 'hostAgentId')).toBeUndefined();
    });
  });

  describe('messages and reads', () => {
    it('rejects mentions outside the room and guards all read paths', async () => {
      await seedAgent('agt-a', { createdBy: OWNER }, OWNER);
      const created = await call('/v1/conversations', 'POST', { kind: 'room', memberAgentIds: ['agt-a'] });
      const convId = stringField(await created.json(), 'id');
      const badMention = await call('/v1/conversations/' + convId + '/runs', 'POST', aguiInput('/v1/conversations/' + convId + '/runs', {
        text: 'hi',
        mentions: [{ kind: 'agent', id: 'agt-outsider', label: '@outsider' }],
        attachments: [],
      }));
      expect(badMention.status).toBe(400);
      await store.put('conversations', makeConversation('cvn-foreign', ['agt-a'], OTHER));
      // Every read and write on another owner's conversation answers as unknown (404), never revealing it.
      const single = await call('/v1/conversations/cvn-foreign', 'GET');
      expect(single.status).toBe(404);
      const items = await call('/v1/conversations/cvn-foreign/items', 'GET');
      expect(items.status).toBe(404);
      const markRead = await call('/v1/conversations/cvn-foreign/mark-read', 'POST');
      expect(markRead.status).toBe(404);
      const sendForeign = await call('/v1/conversations/cvn-foreign/runs', 'POST', aguiInput('/v1/conversations/cvn-foreign/runs', { text: 'hi' }));
      expect(sendForeign.status).toBe(404);
    });

    it('direct chat with a deleted agent fails instead of falling back', async () => {
      await seedAgent('agt-gone', { createdBy: OWNER }, OWNER);
      const created = await call('/v1/conversations', 'POST', { kind: 'direct', memberAgentIds: ['agt-gone'] });
      const convId = stringField(await created.json(), 'id');
      await store.delete('agents', 'agt-gone');
      const res = await call('/v1/conversations/' + convId + '/runs', 'POST', aguiInput('/v1/conversations/' + convId + '/runs', { text: 'hi' }));
      expect(res.status).toBe(404);
      expect(enqueuer.wakes).toHaveLength(0);
    });
  });

  describe('agent-scoped listing', () => {
    it('lists member conversations with truthful pagination and hides foreign rows', async () => {
      await seedAgent('agt-a', { createdBy: OWNER }, OWNER);
      await seedAgent('agt-b', { createdBy: OWNER }, OWNER);
      await store.put('conversations', makeConversation('cvn-1', ['agt-a'], OWNER));
      await store.put('conversations', makeConversation('cvn-2', ['agt-a', 'agt-b'], OWNER));
      await store.put('conversations', makeConversation('cvn-3', ['agt-b'], OWNER));
      await store.put('conversations', makeConversation('cvn-x', ['agt-a'], OTHER));
      const missing = await call('/v1/conversations?agentId=agt-nope', 'GET');
      expect(missing.status).toBe(404);
      const first = await call('/v1/conversations?agentId=agt-a&limit=1', 'GET');
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      expect(itemIds(firstBody)).toHaveLength(1);
      const cursor = stringField(firstBody, 'nextCursor');
      const second = await call('/v1/conversations?agentId=agt-a&limit=1&cursor=' + encodeURIComponent(cursor), 'GET');
      const secondIds = itemIds(await second.json());
      expect(secondIds).toHaveLength(1);
      expect(secondIds[0]).not.toBe(itemIds(firstBody)[0]);
      const all = await call('/v1/conversations?agentId=agt-a', 'GET');
      expect(itemIds(await all.json()).sort()).toEqual(['cvn-1', 'cvn-2']);
      const unfiltered = await call('/v1/conversations', 'GET');
      expect(itemIds(await unfiltered.json()).sort()).toEqual(['cvn-1', 'cvn-2', 'cvn-3']);
    });
  });

  describe('bounded scans', () => {
    it('signals truncation instead of claiming completeness', async () => {
      for (let i = 0; i < 205; i++) {
        await seedAgent('agt-cap-' + String(i), { createdBy: OWNER }, OWNER);
      }
      const capped = await listAll(store, 'agents', 1);
      expect(capped.truncated).toBe(true);
      expect(capped.items).toHaveLength(200);
      const full = await listAll(store, 'agents');
      expect(full.truncated).toBe(false);
      expect(full.items).toHaveLength(205);
    });
  });
});

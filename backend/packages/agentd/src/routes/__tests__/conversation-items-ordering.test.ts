/**
 * A36: GET /v1/conversations/:id/items must return rows in `at`-ascending order, not
 * insertion order. Mirrors the real conv-juno case where a greeting stamped 14:54:42.846Z
 * was listed after a reply stamped 14:54:56.284Z.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import type { Agent, Item } from '@agent-desktop/public-contracts';
import { createTestApp, ownerHeaders, withDefaultOwner } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';

const OWNER = getConfig().OWNER_ID;
const AT = '2026-10-06T00:00:00.000Z';

class RecordingEnqueuer {
  wakes: unknown[] = [];
  async enqueue(event: unknown): Promise<{ accepted: boolean }> {
    this.wakes.push(event);
    return { accepted: true };
  }
  async stopRun(): Promise<void> {}
  async resolveAwakeable(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
}

function makeAgent(id: string): Agent {
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
    createdBy: OWNER,
    createdAt: AT,
    updatedAt: AT,
  };
}

function agentMessage(id: string, conversationId: string, at: string, markdown: string): Item {
  return { id, conversationId, type: 'agent_message', agentId: 'agt-a', markdown, citations: [], at };
}

describe('conversation items ordering (A36)', () => {
  let store: Store;
  let app: Hono;

  async function call(path: string, method: string, body?: unknown): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: { ...ownerHeaders(getConfig().OWNER_ID), 'Content-Type': 'application/json' },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return app.request(path, init);
  }

  beforeEach(async () => {
    const mem = createMemoryStore();
    store = withDefaultOwner(mem, getConfig().OWNER_ID);
    const enqueuer = new RecordingEnqueuer();
    app = createTestApp({ store, bus: mem.eventBus, enqueuer });
    await store.put('agents', makeAgent('agt-a'));
  });

  it('returns items in at-ascending order even when inserted out of order', async () => {
    const res = await call('/v1/conversations', 'POST', {
      kind: 'direct',
      memberAgentIds: ['agt-a'],
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const convId = (await res.json() as { id: string }).id;

    // Insert the later-stamped reply FIRST, then the earlier-stamped greeting.
    await store.put('items', agentMessage('itm-a-late', convId, '2026-10-05T14:54:56.284Z', 'reply'), { conversationId: convId });
    await store.put('items', agentMessage('itm-z-early', convId, '2026-10-05T14:54:42.846Z', 'greeting'), { conversationId: convId });

    const got = await call('/v1/conversations/' + convId + '/items', 'GET');
    expect(got.status, await got.clone().text()).toBe(200);
    const body = (await got.json()) as { items: Item[] };
    expect(body.items.map((item) => item.id)).toEqual(['itm-z-early', 'itm-a-late']);
  });
});

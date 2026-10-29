/**
 * A question never suspends its run: answering it posts the answer as the user's next chat message
 * (the same admission path as a typed message), and typing instead closes the open card.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Agent } from '@agent-desktop/public-contracts';
import type { Enqueuer, Store, StoredRequest, WakeEvent } from '@agent-desktop/contracts';
import { aguiInput } from '../../../../../tests/agui-input.js';
import { createTestApp, ownerHeaders, withDefaultOwner } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';

const OWNER = getConfig().OWNER_ID;
const AT = '2026-10-08T00:00:00.000Z';

class RecordingEnqueuer implements Enqueuer {
  wakes: WakeEvent[] = [];
  failEnqueue = false;

  async enqueue(event: WakeEvent): Promise<{ accepted: boolean; reason?: string }> {
    if (this.failEnqueue) throw new Error('restate ingress unavailable');
    this.wakes.push(event);
    return { accepted: true };
  }

  async stopRun(): Promise<void> {}
  async resolveAwakeable(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
}

const agent: Agent = {
  id: 'agt-a',
  name: 'Agent',
  handle: 'agt-a',
  avatar: { shape: 'circle', color: 1, eyes: 'dot' },
  title: 'Test agent',
  status: 'idle',
  section: 'Inbox',
  pinned: false,
  lastActivity: 'Just created',
  unreadCount: 0,
  model: { planner: { provider: 'openai', model: 'm' }, computer: { provider: 'openai', model: 'm' }, fast: { provider: 'openai', model: 'm' } },
  channels: [],
  macAccess: false,
  skillIds: [],
  pluginIds: [],
  sharing: { publishedToTeam: false },
  createdBy: OWNER,
  createdAt: AT,
  updatedAt: AT,
};


function question(id: string, conversationId: string, block: unknown): StoredRequest {
  return {
    id,
    kind: 'question',
    status: 'pending',
    title: 'Question',
    summary: 'q',
    agentId: 'agt-a',
    runId: 'run-1',
    conversationId,
    createdAt: AT,
    payload: { kind: 'question', ui: { version: 1, blocks: [block] } },
  } as StoredRequest;
}

describe('question answers', () => {
  let store: Store;
  let app: Hono;
  let enqueuer: RecordingEnqueuer;
  let convId: string;

  const call = (path: string, body: unknown): Promise<Response> =>
    Promise.resolve(app.request(path, { method: 'POST', headers: ownerHeaders(OWNER, true), body: JSON.stringify(body) }));

  async function userTexts(): Promise<string[]> {
    const items = (await store.list('items', { where: { conversationId: convId } })).items;
    return items.flatMap((item) => (item.type === 'user_message' ? [item.text] : []));
  }

  beforeEach(async () => {
    const mem = createMemoryStore();
    store = withDefaultOwner(mem, OWNER);
    enqueuer = new RecordingEnqueuer();
    app = createTestApp({ store, bus: mem.eventBus, enqueuer });
    await store.put('agents', agent);
    const created = await call('/v1/conversations', { kind: 'direct', memberAgentIds: ['agt-a'] });
    convId = ((await created.json()) as { id: string }).id;
  });

  it('posts the chosen option label as the next user message, once, even when the answer is retried', async () => {
    await store.put('requests', question('req-1', convId, { type: 'choices', id: 'go', options: [{ id: 'yes', label: 'Continue' }, { id: 'no', label: 'Cancel' }] }));
    expect((await call('/v1/requests/req-1/resolve', { action: 'answer', answers: { go: 'yes' } })).status).toBe(200);
    expect((await call('/v1/requests/req-1/resolve', { action: 'answer', answers: { go: 'no' } })).status).toBe(200);

    expect(await userTexts()).toEqual(['Continue']);
    expect(enqueuer.wakes.map((wake) => [wake.kind, wake.agentId])).toEqual([['user_message', 'agt-a']]);
    expect((await store.get('requests', 'req-1'))?.status).toBe('answered');
  });

  it('posts "Label: value" lines for a fields answer, and keeps the decision when the wake fails until a retry', async () => {
    await store.put('requests', question('req-2', convId, { type: 'fields', id: 'form', fields: [{ id: 'city', label: 'City', kind: 'text' }, { id: 'note', label: 'Note', kind: 'text', required: false }] }));
    enqueuer.failEnqueue = true;
    expect((await call('/v1/requests/req-2/resolve', { action: 'answer', answers: { city: 'Singapore' } })).status).toBe(502);
    expect((await store.get('requests', 'req-2'))?.status).toBe('answered');

    enqueuer.failEnqueue = false;
    expect((await call('/v1/requests/req-2/resolve', { action: 'answer', answers: { city: 'Singapore' } })).status).toBe(200);
    expect(await userTexts()).toEqual(['City: Singapore']);
    expect(enqueuer.wakes).toHaveLength(1);
  });

  it('closes a question that is still open when the user types instead', async () => {
    await store.put('requests', question('req-3', convId, { type: 'choices', id: 'go', options: [{ id: 'yes', label: 'Continue' }, { id: 'no', label: 'Cancel' }] }));
    const path = '/v1/conversations/' + convId + '/runs';
    expect((await call(path, aguiInput(path, { text: 'Call yourself Milo' }))).status).toBe(202);

    expect((await store.get('requests', 'req-3'))?.status).toBe('expired');
    expect(await userTexts()).toEqual(['Call yourself Milo']);
    expect(enqueuer.wakes).toHaveLength(1);
  });
});

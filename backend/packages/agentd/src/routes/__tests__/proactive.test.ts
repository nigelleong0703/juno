/** The proactive routes (BACKEND §5.10) on the production app assembly: feedback buttons, the rules list, keep and delete, and the silence question's answer. */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import { createTestApp, requestAs, withDefaultOwner } from '../../__tests__/test-app.js';

const OWNER = 'owner-a';
const NOW = '2026-10-01T00:00:00.000Z';

function setup() {
  const mem = createMemoryStore();
  const store: Store = withDefaultOwner(mem, OWNER);
  const app = createTestApp({ store, bus: mem.eventBus, enqueuer: { async enqueue() { return { accepted: true }; }, async stopRun() {}, async resolveAwakeable() {} } as never });
  const call = async (as: string, path: string, method = 'GET', body?: unknown) => {
    const res = await requestAs(app, as, path, { method, ...(body === undefined ? {} : { body }) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const idea = (id = 'idea-1', ownerId = OWNER) => store.put('ideas', { id, ownerId, agentId: 'agt-1', text: 'Draft a note to Priya', prompt: 'p', status: 'open', topic: 'priya-move', source: 'daily', createdAt: NOW, updatedAt: NOW } as never);
  return { store, call, idea };
}

describe('proactive routes', () => {
  it('a "never" press writes a rule the list shows with its source; deleting it removes it', async () => {
    const { call, idea } = setup();
    await idea();
    const pressed = await call(OWNER, '/v1/proactive/feedback', 'POST', { target: { kind: 'idea', id: 'idea-1' }, action: 'never' });
    expect(pressed.status).toBe(200);
    expect(pressed.body['rule']).toMatchObject({ kind: 'dont', strength: 'never', scope: 'topic', text: 'Priya move', source: 'You tapped Never on the idea "Draft a note to Priya"', dueForReview: false });
    expect(pressed.body['idea']).toMatchObject({ id: 'idea-1', status: 'dismissed' });
    const listed = await call(OWNER, '/v1/proactive/rules');
    expect(listed.body['items']).toHaveLength(1);
    const id: string = listed.body['items'][0].id;
    expect((await call(OWNER, '/v1/proactive/rules/' + id, 'DELETE')).status).toBe(200);
    expect((await call(OWNER, '/v1/proactive/rules')).body['items']).toEqual([]);
    expect((await call(OWNER, '/v1/proactive/rules/' + id, 'DELETE')).status).toBe(404);
  });

  it('"keep" moves a soft rule\'s review date on; a hard rule has none to keep', async () => {
    const { call, idea } = setup();
    await idea();
    await idea('idea-2');
    const soft = (await call(OWNER, '/v1/proactive/feedback', 'POST', { target: { kind: 'idea', id: 'idea-1' }, action: 'less' })).body['rule'];
    const hard = (await call(OWNER, '/v1/proactive/feedback', 'POST', { target: { kind: 'idea', id: 'idea-2' }, action: 'never', scope: 'type' })).body['rule'];
    expect(soft).toMatchObject({ kind: 'less', strength: 'less' });
    expect(soft.review).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await call(OWNER, '/v1/proactive/rules/' + soft.id, 'PATCH', { keep: true })).body).toMatchObject({ id: soft.id, dueForReview: false });
    expect((await call(OWNER, '/v1/proactive/rules/' + hard.id, 'PATCH', { keep: true })).status).toBe(404);
    expect((await call(OWNER, '/v1/proactive/rules/' + soft.id, 'PATCH', { keep: false })).status).toBe(400);
  });

  it('another account\'s idea answers like a missing one and writes nothing; its rules are not visible', async () => {
    const { call, idea } = setup();
    await idea('idea-b', 'owner-b');
    expect((await call(OWNER, '/v1/proactive/feedback', 'POST', { target: { kind: 'idea', id: 'idea-b' }, action: 'never' })).status).toBe(404);
    expect((await call(OWNER, '/v1/proactive/rules')).body['items']).toEqual([]);
    expect((await call(OWNER, '/v1/proactive/feedback', 'POST', { target: { kind: 'idea', id: 'idea-b' }, action: 'bogus' })).status).toBe(400);
  });

  it('answering the silence question "yes" writes the soft rule and wakes nobody; "no" writes nothing', async () => {
    const { store, call } = setup();
    for (const [id, choice] of [['req-no', 'no'], ['req-yes', 'yes']] as const) {
      await store.put('requests', {
        id, kind: 'question', status: 'pending', title: 'Want fewer of these?', summary: 's', agentId: 'agt-1', ownerId: OWNER, createdAt: NOW,
        silenceQuestion: { text: 'Goal check-in messages', source: 'You said yes to "Want fewer of these?"' },
        payload: { kind: 'question', ui: { version: 1, blocks: [{ type: 'choices', id: 'fewer', options: [{ id: 'yes', label: 'Yes, fewer' }, { id: 'no', label: 'Keep them' }] }] } },
      } as never);
      expect((await call(OWNER, '/v1/requests/' + id + '/resolve', 'POST', { action: 'answer', answers: { fewer: choice } })).status, id).toBe(200);
      const rules = (await call(OWNER, '/v1/proactive/rules')).body['items'] as Array<{ text: string }>;
      expect(rules.map((rule) => rule.text), id).toEqual(choice === 'yes' ? ['Goal check-in messages'] : []);
    }
    expect((await call(OWNER, '/v1/proactive/rules')).body['items'][0]).toMatchObject({ kind: 'less', scope: 'type' });
  });
});

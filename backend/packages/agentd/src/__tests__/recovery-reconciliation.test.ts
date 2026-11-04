import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Enqueuer, Store, StoredRequest, WakeEvent } from '@agent-desktop/contracts';
import { createTestApp, ownerHeaders, withDefaultOwner } from './test-app.js';
import { getConfig } from '../config.js';

const OWNER = getConfig().OWNER_ID;
const OTHER = `${OWNER}-other`;
const AT = '2026-10-29T00:00:00.000Z';

class RecordingEnqueuer implements Enqueuer {
  resolutions: Array<{ id: string; value: unknown }> = [];
  async enqueue(_event: WakeEvent): Promise<{ accepted: boolean }> { return { accepted: true }; }
  async resolveAwakeable(id: string, value: unknown): Promise<void> { this.resolutions.push({ id, value }); }
  async stopRun(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
}

/** The question an agent asks about an uncertain action (ask_about_uncertain_action): the run does not wait on it. */
function question(id: string): StoredRequest {
  return {
    id, kind: 'question', status: 'pending', title: 'Agent Question', summary: 'The email to Bob may already have gone out. Send it again?',
    agentId: 'agent-recovery', conversationId: 'conversation-recovery', runId: 'run-recovery', interrupted: true,
    payload: { kind: 'question', ui: { version: 1, blocks: [
      { type: 'text', text: 'The email to Bob may already have gone out and I cannot see it. Send it again?' },
      { type: 'choices', id: 'recovery_outcome', options: [{ id: 'redo', label: 'Send again' }, { id: 'skip', label: "Don't send" }] },
    ] } },
    createdAt: AT,
    reconciliation: { stepId: 'step-' + id, tool: 'send_message', fingerprint: 'a'.repeat(64), state: 'pending' },
  };
}

describe('the answer to the question about an uncertain action', () => {
  let store: Store;
  let app: Hono;
  let enqueuer: RecordingEnqueuer;

  const call = (owner: string, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    Promise.resolve(app.request(path, { method, headers: ownerHeaders(owner, body !== undefined), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const userMessages = async () => (await store.list('items', { where: { conversationId: 'conversation-recovery' } })).items.filter((item) => item.type === 'user_message');

  beforeEach(async () => {
    const raw = createMemoryStore();
    store = withDefaultOwner(raw, OWNER);
    enqueuer = new RecordingEnqueuer();
    app = createTestApp({ store, bus: raw.eventBus, enqueuer });
    await store.put('agents', {
      id: 'agent-recovery', name: 'Recovery', handle: 'recovery-agent', createdBy: OWNER, ownerId: OWNER, pluginIds: [],
      createdAt: AT, updatedAt: AT,
    } as never);
    await store.put('conversations', { id: 'conversation-recovery', kind: 'direct', agentIds: ['agent-recovery'], memberIds: [OWNER], unreadCount: 0, lastItemAt: AT, createdAt: AT });
    await store.put('requests', question('req-asked'));
  });

  it('"send again" authorizes one repeat, "leave it" keeps the action held back; the answer reaches the agent as the person\'s own message, with no note', async () => {
    expect((await call(OTHER, '/v1/requests/req-asked/resolve', { action: 'answer', answers: { recovery_outcome: 'redo' } })).status).toBe(404);

    expect((await call(OWNER, '/v1/requests/req-asked/resolve', { action: 'answer', answers: { recovery_outcome: 'redo' } })).status).toBe(200);
    expect((await store.get('requests', 'req-asked'))?.reconciliation).toMatchObject({ state: 'authorized' });
    expect((await userMessages()).map((item) => (item.type === 'user_message' ? item.text : ''))).toEqual(['Send again']);
    // Nothing waits on an awakeable: the run was not suspended on this question.
    expect(enqueuer.resolutions).toHaveLength(0);

    await store.put('requests', question('req-declined'));
    expect((await call(OWNER, '/v1/requests/req-declined/resolve', { action: 'answer', answers: { recovery_outcome: 'skip' } })).status).toBe(200);
    expect((await store.get('requests', 'req-declined'))?.reconciliation).toMatchObject({ state: 'declined' });
  });

  it('a dismissed question is a no, and a second answer changes nothing', async () => {
    expect((await call(OWNER, '/v1/requests/req-asked/resolve', { action: 'deny' })).status).toBe(200);
    expect(await store.get('requests', 'req-asked')).toMatchObject({ status: 'denied', reconciliation: { state: 'declined' } });
    const again = await call(OWNER, '/v1/requests/req-asked/resolve', { action: 'answer', answers: { recovery_outcome: 'redo' } });
    expect(again.status).toBe(200);
    expect((await store.get('requests', 'req-asked'))?.reconciliation).toMatchObject({ state: 'declined' });
  });

  it('never shows the private link to a client', async () => {
    const publicRequest = await call(OWNER, '/v1/requests/req-asked', undefined, 'GET');
    expect(JSON.stringify(await publicRequest.json())).not.toContain('reconciliation');
  });
});

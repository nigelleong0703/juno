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

function request(id: string, state: NonNullable<StoredRequest['reconciliation']>['state'] = 'pending'): StoredRequest {
  return {
    id, kind: 'question', status: 'pending', title: 'Check an uncertain action', summary: 'Outcome needs review.',
    agentId: 'agent-recovery', conversationId: 'conversation-recovery', runId: 'run-recovery', awakeableId: 'awake-' + id,
    payload: { kind: 'question', ui: { version: 1, title: 'What did you verify?', blocks: [{ type: 'choices', id: 'recovery_outcome', options: [
      { id: 'reported_done', label: 'I checked: it succeeded' },
      { id: 'confirmed_absent_retry', label: 'I checked: it did not happen' },
      { id: 'still_unknown', label: 'Still unknown' },
    ] }] } },
    createdAt: AT,
    reconciliation: { stepId: 'step-' + id, tool: 'send_message', fingerprint: 'a'.repeat(64), reason: 'receipt unavailable', state },
  };
}

describe('persisted reconciliation request decisions', () => {
  let store: Store;
  let app: Hono;
  let enqueuer: RecordingEnqueuer;

  const call = (owner: string, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    Promise.resolve(app.request(path, { method, headers: ownerHeaders(owner, body !== undefined), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));

  beforeEach(async () => {
    const raw = createMemoryStore();
    store = withDefaultOwner(raw, OWNER);
    enqueuer = new RecordingEnqueuer();
    app = createTestApp({ store, bus: raw.eventBus, enqueuer });
    await store.put('requests', request('req-recovery'));
  });

  it('persists owner-reported success as a user claim, never as adapter evidence, and resolves the durable wait once', async () => {
    const foreign = await call(OTHER, '/v1/requests/req-recovery/resolve', { action: 'answer', answers: { recovery_outcome: 'reported_done' } });
    expect(foreign.status).toBe(404);
    expect(enqueuer.resolutions).toHaveLength(0);

    const response = await call(OWNER, '/v1/requests/req-recovery/resolve', { action: 'answer', answers: { recovery_outcome: 'reported_done' } });
    expect(response.status).toBe(200);
    const saved = await store.get('requests', 'req-recovery');
    expect(saved?.reconciliation).toMatchObject({ state: 'user_reported_succeeded', source: 'owner_report' });
    expect(enqueuer.resolutions).toHaveLength(1);
    expect(JSON.stringify(enqueuer.resolutions[0]?.value)).toContain('reported_done');

    const replay = await call(OWNER, '/v1/requests/req-recovery/resolve', { action: 'answer', answers: { recovery_outcome: 'still_unknown' } });
    expect(replay.status).toBe(200);
    expect((await store.get('requests', 'req-recovery'))?.reconciliation?.state).toBe('user_reported_succeeded');
    expect(enqueuer.resolutions).toHaveLength(1);

    const publicRequest = await call(OWNER, '/v1/requests/req-recovery', undefined, 'GET');
    const publicBody: unknown = await publicRequest.json();
    expect(JSON.stringify(publicBody)).not.toContain('reconciliation');
  });

  it('distinguishes owner-confirmed absence plus retry authorization from unresolved outcome across a fresh app assembly', async () => {
    await call(OWNER, '/v1/requests/req-recovery/resolve', { action: 'answer', answers: { recovery_outcome: 'confirmed_absent_retry' } });
    expect((await store.get('requests', 'req-recovery'))?.reconciliation).toMatchObject({ state: 'user_confirmed_not_executed', source: 'owner_report' });
    expect(enqueuer.resolutions).toHaveLength(1);

    const raw = createMemoryStore();
    app = createTestApp({ store, bus: raw.eventBus, enqueuer });
    await store.put('requests', request('req-recovery-unknown'));
    await call(OWNER, '/v1/requests/req-recovery-unknown/resolve', { action: 'answer', answers: { recovery_outcome: 'still_unknown' } });
    const unknown = await store.get('requests', 'req-recovery-unknown');
    expect(unknown?.reconciliation).toMatchObject({ state: 'still_unknown', source: 'owner_report' });
    expect(enqueuer.resolutions).toHaveLength(2);
  });

  it('wakes an active reconciliation wait when the owner denies the request and keeps the action unknown', async () => {
    const response = await call(OWNER, '/v1/requests/req-recovery/resolve', { action: 'deny' });
    expect(response.status).toBe(200);
    expect(enqueuer.resolutions).toHaveLength(1);
    expect((await store.get('requests', 'req-recovery'))).toMatchObject({
      status: 'denied', reconciliation: { state: 'still_unknown', source: 'owner_report' },
    });
    const duplicate = await call(OWNER, '/v1/requests/req-recovery/resolve', { action: 'deny' });
    expect(duplicate.status).toBe(200);
    expect(enqueuer.resolutions).toHaveLength(1);
  });

  it('records a late card answer as an owner report and never claims the interrupted external action did not happen', async () => {
    await store.put('agents', {
      id: 'agent-recovery', name: 'Recovery', handle: 'recovery-agent', createdBy: OWNER, ownerId: OWNER, pluginIds: [],
      createdAt: AT, updatedAt: AT,
    } as never);
    await store.put('conversations', {
      id: 'conversation-recovery', kind: 'direct', agentIds: ['agent-recovery'], memberIds: [OWNER], unreadCount: 0,
      lastItemAt: AT, createdAt: AT,
    });
    await store.patch('requests', 'req-recovery', { interrupted: true, awakeableId: undefined });
    const response = await call(OWNER, '/v1/requests/req-recovery/resolve', {
      action: 'answer', answers: { recovery_outcome: 'still_unknown' },
    });
    const body: unknown = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(enqueuer.resolutions).toHaveLength(0);
    const messages = (await store.list('items', { where: { conversationId: 'conversation-recovery' } })).items;
    expect(messages.some((item) => item.type === 'user_message' && item.text.includes('external action may or may not have happened'))).toBe(true);
    expect((await store.get('requests', 'req-recovery'))?.reconciliation).toMatchObject({ state: 'still_unknown', source: 'owner_report' });
  });
});

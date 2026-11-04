import { describe, expect, it } from 'vitest';
import type { Run } from '@agent-desktop/public-contracts';
import { createMemoryStore } from '../../../testing/store.js';
import type { StoredRequest } from '../../../contracts/index.js';
import { migrateRecoveryCards } from '../recovery-migrate.js';

const AT = '2026-10-31T16:22:00.000Z';

/** A card as the old flow wrote it: the old state names, `reason` and `source` on the link. */
function oldCard(id: string, state: string, runId: string): StoredRequest {
  return {
    id, kind: 'question', status: state === 'pending' ? 'pending' : 'answered', title: 'Check an uncertain action', summary: 'The action may have taken effect.',
    agentId: 'agent', conversationId: 'conv', runId, createdAt: AT, payload: { kind: 'question', ui: { version: 1, blocks: [] } },
    reconciliation: { stepId: 'stp-' + id, tool: 'maps_lookup', fingerprint: 'a'.repeat(64), reason: 'HTTP 400', source: 'owner_report', state },
  } as unknown as StoredRequest;
}

const run = (id: string, status: Run['status']): Run => ({
  id, agentId: 'agent', conversationId: 'conv', title: id, status, kind: 'chat', steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
});

describe('ending the "Check an uncertain action" cards', () => {
  it('withdraws a waiting card (and ends the run that waited on it), renames the states of answered ones, and runs once', async () => {
    const store = createMemoryStore();
    await store.put('runs', { ...run('run-waiting', 'waiting_for_input'), effectReview: 'open' } as never);
    await store.put('runs', run('run-done', 'completed'));
    await store.put('requests', oldCard('req-waiting', 'pending', 'run-waiting'));
    await store.put('requests', oldCard('req-authorized', 'user_confirmed_not_executed', 'run-done'));
    await store.put('requests', oldCard('req-unknown', 'still_unknown', 'run-done'));
    await store.put('requests', oldCard('req-consumed', 'retry_consumed', 'run-done'));
    await store.put('requests', oldCard('req-reported', 'user_reported_succeeded', 'run-done'));

    expect(await migrateRecoveryCards(store)).toEqual({ skipped: false, withdrawn: 1, renamed: 4, runsEnded: 1 });

    expect(await store.get('requests', 'req-waiting')).toMatchObject({ status: 'expired' });
    expect((await store.get('requests', 'req-waiting'))?.reconciliation).toBeUndefined();
    expect(await store.get('runs', 'run-waiting')).toMatchObject({ status: 'failed', effectReview: 'resolved' });
    expect(await store.get('runs', 'run-done')).toMatchObject({ status: 'completed' });
    const states = Object.fromEntries((await store.list('requests', { limit: 20 })).items.map((request) => [request.id, request.reconciliation?.state]));
    expect(states).toMatchObject({ 'req-authorized': 'authorized', 'req-unknown': 'declined', 'req-consumed': 'consumed', 'req-reported': 'completed' });
    expect(JSON.stringify((await store.get('requests', 'req-authorized'))?.reconciliation)).not.toMatch(/reason|source/);

    expect((await migrateRecoveryCards(store)).skipped).toBe(true);
  });
});

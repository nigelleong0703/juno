/**
 * H-79: POST /v1/runs/:id/stop requests a stop and never fakes it. A finished run comes back unchanged
 * with no event; a live run only gets the cancel signal (the run finalizes itself); an orphaned row
 * whose workflow is gone is marked stopped here.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Enqueuer } from '@agent-desktop/contracts';
import type { Run } from '@agent-desktop/public-contracts';
import { registerRuns } from '../runs.js';
import { withTestOwner } from '../../__tests__/test-owner.js';
import { testChannels } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';

const OWNER = getConfig().OWNER_ID;
const AT = '2026-10-09T12:00:00.000Z';

function runRow(id: string, status: Run['status']): Run {
  return { id, agentId: 'a', conversationId: 'c', title: 't', status, kind: 'chat', steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT };
}

async function setup(stopFails = false, state?: 'running' | 'none') {
  const raw = createMemoryStore();
  const store = raw.forOwner === undefined ? raw : raw.forOwner(OWNER);
  const stopped: string[] = [];
  const released: Array<[string, string]> = [];
  const enqueuer: Enqueuer = {
    enqueue: async () => ({ accepted: true }),
    stopRun: async (id: string) => { if (stopFails) throw new Error('no workflow'); stopped.push(id); },
    resolveAwakeable: async () => {},
    scheduleRoutine: async () => {},
    ...(state === undefined ? {} : { runState: async () => state }),
    releaseSession: async (key: string, id: string) => { released.push([key, id]); },
  };
  const app = withTestOwner(new Hono());
  registerRuns(app, { store, bus: raw.eventBus, enqueuer, channels: testChannels });
  const events: string[] = [];
  await raw.eventBus.subscribe((e) => { events.push(e.event.type); });
  return { app, store, stopped, released, events };
}

describe('POST /v1/runs/:id/stop', () => {
  it('changes nothing when the cancel cannot be delivered to a live or unknown run', async () => {
    const h = await setup(true);
    await h.store.put('runs', runRow('flaky', 'running'), { agentId: 'a', conversationId: 'c' });
    const res = await h.app.request('/v1/runs/flaky/stop', { method: 'POST' });
    expect(res.status).toBe(502);
    expect((await h.store.get('runs', 'flaky'))?.status).toBe('running');
    expect(h.released).toEqual([]);
    expect(h.events).not.toContain('RUN_FINISHED');
  });

  it('cleans up like a finalize: an orphan expires its pending requests and stops its live children', async () => {
    const h = await setup(false, 'none');
    await h.store.put('runs', runRow('parent', 'running'), { agentId: 'a', conversationId: 'c' });
    await h.store.put('runs', { ...runRow('kid', 'running'), parentRunId: 'parent' }, { agentId: 'a', conversationId: 'c' });
    await h.store.put('requests', { id: 'req-1', runId: 'parent', agentId: 'a', conversationId: 'c', kind: 'approval', title: 'Approve?', status: 'pending', createdAt: AT, payload: { kind: 'approval', why: 'x' } } as never);
    const res = await h.app.request('/v1/runs/parent/stop', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await h.store.get('requests', 'req-1'))?.status).toBe('expired');
    expect((await h.store.get('runs', 'kid'))?.status).toBe('stopped');
    expect(h.events.filter((e) => e === 'RUN_FINISHED')).toHaveLength(2);
  });
});

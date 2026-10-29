/** Uses actual migrations and production gate/tool code on a Postgres store (ids are unique per test: Postgres keeps rows). */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { ToolContext, ToolOrchestrationRuntime } from 'juno-agent/contracts';
import { browserGoalGate } from 'juno-agent/modules/tools/computer/browser-goal-gate';
import { createGoalBrowserTools } from 'juno-agent/modules/tools/tools/browserGoals';
import { createStore } from '../index.js';
import { closeScratchPostgres, scratchPostgresUrl } from './store-backends.js';

afterAll(closeScratchPostgres);

const completion = [{ match: { label: 'Alias' }, property: 'value' as const, equals: 'Mira' }];
const uid = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

describe('browser goal durability', () => {
  it('commits before effects, survives reopening, rejects another stage and isolates owners/runs', async () => {
    const url = await scratchPostgresUrl();
    const [owner, agent, conversation, run] = [uid('o'), uid('a'), uid('c'), uid('r')];
    let store = await createStore(url);
    const context = () => ({ store, ownerId: owner, agentId: agent, conversationId: conversation, runId: run, stepId: 's1' } as ToolContext);
    try {
      await store.forOwner!(owner).put('runs', { id: run, agentId: agent, conversationId: conversation } as never);
      const gate = browserGoalGate(context());
      const begun = await gate.begin('Edit alias', completion, false);
      expect(begun.gate?.status).toBe('pending');
      await gate.bindTab(begun.gate!, 't1');
      await store.close(); store = await createStore(url);
      const restored = await browserGoalGate(context()).read();
      expect(restored).toMatchObject({ status: 'pending', completion, tab: 't1' });
      expect((await browserGoalGate(context()).begin('Edit alias', completion, false)).gate).toEqual(restored);
      const runtime: ToolOrchestrationRuntime = { signal: new AbortController().signal, journal: async () => { throw new Error('must not ask Jev'); }, run: async () => { throw new Error('must not read or mutate browser'); } };
      const result = await createGoalBrowserTools().find(t => t.name === 'browser.do')!.orchestrate!({ goal: 'Next stage', completion }, { ...context(), stepId: 's2' }, runtime);
      if (result.kind !== 'completed') throw new Error('unexpected cancellation');
      expect(result.result.isError).toBe(true);
      expect(result.result.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining('previous_browser_goal_pending') }));
      expect(await browserGoalGate({ ...context(), ownerId: uid('another') }).read()).toBeNull();
      expect(await browserGoalGate({ ...context(), runId: uid('another') }).read()).toBeNull();
      expect(await browserGoalGate(context(), 'mac').read()).toBeNull();
    } finally { await store.close(); }
  });

  it('serializes concurrent first stages and keeps the winning criteria', async () => {
    const url = await scratchPostgresUrl();
    const [owner, agent, conversation, run] = [uid('o'), uid('a'), uid('c'), uid('r')];
    const store = await createStore(url);
    try {
      await store.forOwner!(owner).put('runs', { id: run, agentId: agent, conversationId: conversation } as never);
      const context = { store, ownerId: owner, agentId: agent, conversationId: conversation, runId: run } as ToolContext;
      const results = await Promise.all(['s1', 's2'].map(stepId => browserGoalGate({ ...context, stepId }).begin(stepId, completion, false)));
      expect(results.filter(r => r.gate)).toHaveLength(1);
      expect(results.filter(r => r.blocked)).toHaveLength(1);
      expect((await browserGoalGate(context).read())?.goal).toBe(results.find(r => r.gate)?.gate?.goal);
    } finally { await store.close(); }
  });
});

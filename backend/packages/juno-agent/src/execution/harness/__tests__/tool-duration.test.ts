/** PH11 active tool duration: the step duration and the exposed activeMs are measured LOCALLY inside
 * the authorized effect, so a durable approval wait before the effect is never charged as active time,
 * a model-claimed duration is never trusted, and a replay reports the cached value with no extra
 * elapsed time. Drives the real executeSingleToolCall path with a real ask-then-approve wait. */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, it, expect } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { Doc, Store, Tool, ToolRegistry, ToolResult, WakeEvent } from '../../../contracts/index.js';
import { CANCELLED } from '../services/cancel.js';
import { executeSingleToolCall } from '../services/run-tools.js';
import type { ToolCallContext } from '../services/tool-policy.js';
import type { RunInput, RunServices } from '../services/run-types.js';
import { ScriptedModel } from '../testing/stubs.js';

const OWNER = 'owner-1';
const AGENT = 'agent-1';
const CONV = 'conv-1';
const AT = '2026-10-08T00:00:00.000Z';
const EFFECT_MS = 60;
const APPROVAL_WAIT_MS = 220;

const wake: WakeEvent = {
  id: 'w', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV,
  kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, at: AT, status: 'accepted',
};

interface AskContext extends ToolCallContext {
  decide(value: unknown): void;
}

function askContext(): AskContext {
  const journal = new Map<string, unknown>();
  let settle: ((value: unknown) => void) | undefined;
  return {
    rand: { uuidv4: () => 'stp-1' },
    run<T>(name: string, action: () => Promise<T>): RestatePromise<T> {
      if (journal.has(name)) return RestatePromise.resolve(structuredClone(journal.get(name)) as T);
      return RestatePromise.resolve(action().then((value) => { journal.set(name, structuredClone(value)); return value; }));
    },
    awakeable<T>(): { id: string; promise: RestatePromise<T> } {
      const promise = new Promise<T>((resolve) => { settle = (value) => resolve(value as T); });
      return { id: 'awk-1', promise: RestatePromise.resolve(promise) };
    },
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
    decide: (value) => settle?.(value),
  };
}

function slowTool(name: string, counter: { runs: number }): Tool {
  return {
    name, description: name, parameters: {}, replay: 'never', sideEffect: true,
    execute: async (): Promise<ToolResult> => {
      counter.runs += 1;
      await new Promise((resolve) => setTimeout(resolve, EFFECT_MS));
      return { content: [{ type: 'text', text: 'done' }] };
    },
  };
}

async function seed(store: Store): Promise<void> {
  await store.put('agents', { id: AGENT, name: AGENT, handle: AGENT, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 't', status: 'idle', section: 'Work', pinned: false, lastActivity: '', unreadCount: 0, model: { planner: { provider: 'scripted', model: 't' }, computer: { provider: 'scripted', model: 't' }, fast: { provider: 'scripted', model: 't' } }, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdBy: OWNER, createdAt: AT, updatedAt: AT });
  await store.put('runs', {
    id: 'run-1', agentId: AGENT, conversationId: CONV, title: 'p', status: 'running', kind: 'chat', steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
  }, { agentId: AGENT, conversationId: CONV });
  // An ask rule forces a durable approval wait BEFORE the effect.
  await store.put('rules', { id: 'rule-1', description: 'ask', scope: 'action', behavior: 'ask', source: 'user', enabled: true, subject: 'effect', createdAt: AT, createdBy: OWNER });
}

describe('active tool duration', () => {
  it('excludes the durable approval wait and exposes the measured activeMs', async () => {
    const store = createMemoryStore();
    await seed(store);
    const counter = { runs: 0 };
    const tool = slowTool('effect', counter);
    const registry: ToolRegistry = { forAgent: async () => [tool], get: (name) => (name === 'effect' ? tool : undefined) };
    const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: new ScriptedModel(), toolRegistry: registry };
    const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [wake] };
    const ctx = askContext();
    const pending = executeSingleToolCall(ctx, services, input, 'run-1', 0, 0, { id: 'call-1', name: 'effect', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, APPROVAL_WAIT_MS));
    const request = (await store.list('requests', { limit: 5 })).items[0];
    if (request !== undefined) await store.patch('requests', request.id, { status: 'approved', resolvedAt: AT });
    ctx.decide({ action: 'approve' });
    const outcome = await pending;
    if (outcome === CANCELLED) throw new Error('unexpected cancellation');
    expect(counter.runs).toBe(1);
    const activeMs = outcome.activeMs;
    expect(activeMs).toBeGreaterThanOrEqual(EFFECT_MS - 20);
    expect(activeMs).toBeLessThan(APPROVAL_WAIT_MS);
    // The step's duration is the trusted active time, not the wall time that included the wait.
    const step = (await store.list('steps', { limit: 5 })).items[0] as Doc<'steps'>;
    expect(step.durationMs).toBe(activeMs);
    expect(step.durationMs).toBeLessThan(APPROVAL_WAIT_MS);
  });

  it('reports the cached active time on a replay with no extra elapsed time', async () => {
    const store = createMemoryStore();
    await seed(store);
    const counter = { runs: 0 };
    const tool = slowTool('effect', counter);
    const registry: ToolRegistry = { forAgent: async () => [tool], get: (name) => (name === 'effect' ? tool : undefined) };
    const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: new ScriptedModel(), toolRegistry: registry };
    const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [wake] };
    const ctx = askContext();
    const call = { id: 'call-1', name: 'effect', arguments: {} };
    const first = executeSingleToolCall(ctx, services, input, 'run-1', 0, 0, call);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const request = (await store.list('requests', { limit: 5 })).items[0];
    if (request !== undefined) await store.patch('requests', request.id, { status: 'approved', resolvedAt: AT });
    ctx.decide({ action: 'approve' });
    const started = await first;
    const before = started === CANCELLED ? undefined : started.activeMs;
    expect(before).toBeDefined();
    // The fence returns the cached result: the effect does not re-run and the active time is unchanged.
    const replayPending = executeSingleToolCall(ctx, services, input, 'run-1', 0, 0, call);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = (await store.list('requests', { limit: 5 })).items[0];
    if (again !== undefined) await store.patch('requests', again.id, { status: 'approved', resolvedAt: AT });
    ctx.decide({ action: 'approve' });
    const replay = await replayPending;
    expect(counter.runs).toBe(1);
    const after = replay === CANCELLED ? undefined : replay.activeMs;
    expect(after).toBe(before);
  });
});

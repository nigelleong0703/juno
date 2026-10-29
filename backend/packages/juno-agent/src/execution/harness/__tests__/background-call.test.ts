/**
 * H-73: background MCP calls. Only `mcp.*` calls with background:true go to the background; the start is
 * journaled and passes the arguments without the harness flag; the BackgroundCall object runs the tool
 * at most once (runFencedTool on the issuing step row), reports one task_done with the result, ignores a
 * redelivery, and reports an interrupted call as failed without running it again.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import type { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { BackgroundCallStart, BackgroundTask, Doc, Store, Tool, ToolRegistry, ToolResult, WakeEvent } from '../../../contracts/index.js';
import { abortBackgroundCall, endBackgroundTask } from '../../../modules/tasks/background-registry.js';
import { runBackgroundCall, startBackgroundCall } from '../services/background-call.js';
import type { RunInput, RunServices } from '../services/run-types.js';

const AT = '2026-10-09T10:00:00.000Z';
const wake: WakeEvent = {
  id: 'w', ownerId: 'owner', agentId: 'a', sessionKey: 'a:c', conversationId: 'c', kind: 'user_message',
  origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, at: AT, status: 'accepted',
};
const input: RunInput = { agentId: 'a', conversationId: 'c', sessionKey: 'a:c', wakeEvents: [wake] };
const step: Doc<'steps'> = { id: 'stp_1', runId: 'run-1', index: 0, kind: 'mcp', verb: 'Executed', target: 'mcp.github.search', status: 'running', startedAt: AT, durationMs: 0, input: { summary: '{}' } };

const lift = <T>(value: T): RestatePromise<T> => Promise.resolve(value) as unknown as RestatePromise<T>;
const runInline = <T>(_name: string, fn: () => Promise<T>): RestatePromise<T> => fn() as unknown as RestatePromise<T>;

function ownedStore(): Store {
  const raw = createMemoryStore();
  return raw.forOwner === undefined ? raw : raw.forOwner('owner');
}

function countingTool(result: ToolResult): { tool: Tool; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    tool: { name: 'mcp.github.search', description: 'd', parameters: { type: 'object', properties: {} }, replay: 'never', sideEffect: true, execute: async (args) => { calls.push(args); return result; } },
  };
}

function registryWith(tool: Tool): ToolRegistry {
  return { forAgent: async () => [tool], get: (name) => (name === tool.name ? tool : undefined) };
}

/** The effect-time policy re-check reads the exposed tool list, so the started tool must be exposed to the agent. */
const exposedRegistry: ToolRegistry = registryWith(countingTool({ content: [] }).tool);

function objectCtx(key: string) {
  let done = false;
  const wakes: WakeEvent[] = [];
  return {
    wakes,
    ctx: { key, rand: { uuidv4: () => 'u' }, run: runInline, done: async () => done, markDone: () => { done = true; }, now: () => lift(Date.parse(AT)), sendWake: (w: WakeEvent) => { wakes.push(w); } },
  };
}

const callInput = (taskId: string): BackgroundCallStart => ({ taskId, ownerId: 'owner', agentId: 'a', conversationId: 'c', runId: 'run-1', toolName: 'mcp.github.search', arguments: { q: 'bug' }, wake });

describe('background MCP calls', () => {
  it('starts the call once with the harness flag stripped and returns the task id', async () => {
    const starts: BackgroundCallStart[] = [];
    const enqueuer = new NoopEnqueuer();
    const services = { store: ownedStore(), toolRegistry: exposedRegistry, enqueuer: Object.assign(enqueuer,{ startBackgroundCall: async (s: BackgroundCallStart) => { starts.push(s); } }) } as unknown as RunServices;
    const outcome = await startBackgroundCall({ run: runInline }, services, input, 'run-1', step, { name: 'mcp.github.search', arguments: { q: 'bug', background: true } }, true, new AbortController().signal);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ taskId: 'mcp-stp_1', toolName: 'mcp.github.search', arguments: { q: 'bug' } });
    expect(starts[0]?.arguments).not.toHaveProperty('background');
    expect(outcome.kind).toBe('ran');
    if (outcome.kind === 'ran') expect(outcome.result.content[0]).toMatchObject({ text: expect.stringContaining('mcp-stp_1') });
  });

  it('runs the tool once, reports one task_done and ignores a redelivery', async () => {
    const store = ownedStore();
    await store.put('steps', step, { runId: 'run-1' });
    const { tool, calls } = countingTool({ content: [{ type: 'text', text: '3 issues found' }] });
    const h = objectCtx('mcp-stp_1');
    await runBackgroundCall(h.ctx, { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), toolRegistry: registryWith(tool) }, callInput('mcp-stp_1'));
    await runBackgroundCall(h.ctx, { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), toolRegistry: registryWith(tool) }, callInput('mcp-stp_1'));
    expect(calls).toEqual([{ q: 'bug' }]);
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0]).toMatchObject({ id: 'mcp-stp_1:done', kind: 'task_done', payload: { taskKind: 'mcp', status: 'completed', summary: '3 issues found' } });
  });

  it('keeps a long result whole as an artifact and reports a bounded, redacted summary', async () => {
    const store = ownedStore();
    await store.put('steps', step, { runId: 'run-1' });
    const long = 'row ' + 'x'.repeat(5_000) + ' tail-marker';
    const { tool } = countingTool({ content: [{ type: 'text', text: long }] });
    const h = objectCtx('mcp-stp_1');
    await runBackgroundCall(h.ctx, { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), toolRegistry: registryWith(tool) }, callInput('mcp-stp_1'));
    const summary = String(h.wakes[0]?.payload['summary']);
    expect(summary.length).toBeLessThan(2_600);
    expect(summary).toContain('tail-marker');
    expect(summary).toContain('output_read');
    expect((await store.list('artifacts')).items).toHaveLength(1);
  });

  it('reports a tool error as failed', async () => {
    const store = ownedStore();
    await store.put('steps', step, { runId: 'run-1' });
    const { tool } = countingTool({ content: [{ type: 'text', text: 'rate limited' }], isError: true });
    const h = objectCtx('mcp-stp_1');
    await runBackgroundCall(h.ctx, { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), toolRegistry: registryWith(tool) }, callInput('mcp-stp_1'));
    expect(h.wakes[0]?.payload).toMatchObject({ status: 'failed', summary: 'rate limited' });
  });

  it('never re-runs a call that a previous invocation already started', async () => {
    const store = ownedStore();
    // A previous invocation crossed the fence and was cut off before caching a result.
    await store.put('steps', { ...step, execution: { fencedAt: AT } } as Doc<'steps'>, { runId: 'run-1' });
    const { tool, calls } = countingTool({ content: [{ type: 'text', text: 'should not run' }] });
    const h = objectCtx('mcp-stp_1');
    // Replay semantics: the fence step is journaled, so its body does not run again (claimed stays false).
    const replayRun = <T>(name: string, fn: () => Promise<T>): RestatePromise<T> => {
      if (name.endsWith(':fence')) { return lift(undefined as unknown as T); }
      return fn() as unknown as RestatePromise<T>;
    };
    await runBackgroundCall({ ...h.ctx, run: replayRun }, { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), toolRegistry: registryWith(tool) }, callInput('mcp-stp_1'));
    expect(await store.get('steps', step.id)).toMatchObject({ execution: { fencedAt: AT, intent: { tool: 'mcp.github.search' } } });
    expect(calls).toEqual([]);
    expect(h.wakes[0]?.payload).toMatchObject({ status: 'failed' });
    expect((await store.list('requests')).items).toHaveLength(1);
    expect((await store.list('requests')).items[0]).toMatchObject({ interrupted: true, reconciliation: { state: 'pending', stepId: step.id } });
  });

  it('aborts an in-flight call once it is stopped, and stays silent', async () => {
    const store = ownedStore();
    await store.put('steps', step, { runId: 'run-1' });
    const row: BackgroundTask = { id: 'mcp-stp_1', ownerId: 'owner', agentId: 'a', conversationId: 'c', runId: 'run-1', kind: 'mcp', label: 'github', notify: true, chainId: 'run-1', generation: 1, status: 'running', startedAt: AT };
    await store.put('backgroundTasks', row);
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const tool: Tool = {
      ...countingTool({ content: [] }).tool,
      // Stands in for an MCP call that only ends when its signal aborts (the client then sends notifications/cancelled).
      execute: (_args, toolCtx) => { started(); return new Promise<ToolResult>((resolve) => { toolCtx.signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'cancelled' }], isError: true })); }); },
    };
    const h = objectCtx('mcp-stp_1');
    const running = runBackgroundCall(h.ctx, { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), toolRegistry: registryWith(tool) }, callInput('mcp-stp_1'));
    await ready;
    // task_stop marks the row first, then aborts the tracked call.
    await endBackgroundTask(store, 'mcp-stp_1', 'stopped', AT);
    expect(abortBackgroundCall('mcp-stp_1')).toBe(true);
    await running;
    expect(h.wakes).toEqual([]);
  });

  it('refuses a background call past the generation cap', async () => {
    const starts: BackgroundCallStart[] = [];
    const services = { store: ownedStore(), toolRegistry: exposedRegistry, enqueuer: Object.assign(new NoopEnqueuer(),{ startBackgroundCall: async (s: BackgroundCallStart) => { starts.push(s); } }) } as unknown as RunServices;
    const deepWake: WakeEvent = { ...wake, kind: 'task_done', origin: { type: 'system' }, trusted: false, payload: { taskId: 't', taskKind: 'mcp', status: 'completed', summary: '', generation: 3 } };
    const outcome = await startBackgroundCall({ run: runInline }, services, { ...input, wakeEvents: [deepWake] }, 'run-1', step, { name: 'mcp.github.search', arguments: { background: true } }, false, new AbortController().signal);
    expect(starts).toEqual([]);
    expect(outcome.kind === 'ran' && outcome.result.isError).toBe(true);
  });
});

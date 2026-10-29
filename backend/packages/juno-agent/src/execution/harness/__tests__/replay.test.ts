import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, it, expect } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { Doc, Store, Tool, ToolRegistry, ToolResult, WakeEvent } from '../../../contracts/index.js';
import type { Run } from '@agent-desktop/public-contracts';
import { runFencedTool, type ToolRunContext } from '../services/replay.js';
import { executeSingleToolCall } from '../services/run-tools.js';
import { ScriptedModel } from '../testing/stubs.js';
import type { RunInput, RunServices } from '../services/run-types.js';

/** A journaling ctx like Restate's: a completed `run` is replayed, its body is not re-executed. */
function runContext(ids: string[] = ['stp-1']): ToolRunContext {
  const journal = new Map<string, unknown>();
  let next = 0;
  return {
    rand: { uuidv4: () => ids[Math.min(next++, ids.length - 1)] ?? 'stp-x' },
    run<T>(name: string, action: () => Promise<T>): RestatePromise<T> {
      if (journal.has(name)) return RestatePromise.resolve(structuredClone(journal.get(name)) as T);
      return RestatePromise.resolve(action().then((value) => {
        journal.set(name, structuredClone(value));
        return value;
      }));
    },
  };
}

function stepDoc(id = 'stp-1'): Doc<'steps'> {
  return {
    id,
    runId: 'run-1',
    index: 0,
    kind: 'mcp',
    verb: 'Executed',
    target: 'effect',
    status: 'running',
    startedAt: new Date().toISOString(),
    durationMs: 0,
  };
}

describe('replay:never fence', () => {
  it('caches a completed result and reuses it on a fresh recovery', async () => {
    const store = createMemoryStore();
    const step = stepDoc();
    await store.put('steps', step, { runId: step.runId });
    let executions = 0;
    const action = async (): Promise<ToolResult> => {
      executions += 1;
      return { content: [{ type: 'text', text: 'first run' }] };
    };

    const first = await runFencedTool(runContext(), store, step, 'effect', action);
    expect(first.interrupted).toBe(false);
    expect(executions).toBe(1);

    // A new invocation (new journal) has no cached journal entry: the durable store cache answers.
    const recovered = await runFencedTool(runContext(), store, step, 'effect', action);
    expect(executions).toBe(1);
    expect(recovered.interrupted).toBe(false);
    expect(recovered.result.content[0]).toEqual({ type: 'text', text: 'first run' });
  });

  it('reports a cut-off action as interrupted without re-running it', async () => {
    const store = createMemoryStore();
    const step = stepDoc();
    await store.put('steps', step, { runId: step.runId });
    const ctx = runContext();
    let executions = 0;
    let releaseStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const action = async (): Promise<ToolResult> => {
      executions += 1;
      if (executions > 1) return { content: [{ type: 'text', text: 'must not run again' }] };
      releaseStarted();
      return await new Promise<ToolResult>(() => {});
    };

    void runFencedTool(ctx, store, step, 'effect', action);
    await started;

    const recovered = await runFencedTool(ctx, store, step, 'effect', action);
    expect(executions).toBe(1);
    expect(recovered.interrupted).toBe(true);
    expect(recovered.result.isError).toBe(true);
    expect(JSON.stringify(recovered.result)).toContain('interrupted');
  });
});

describe('tool loop', () => {
  const at = new Date().toISOString();
  const wake: WakeEvent = {
    id: 'wake-1',
    ownerId: 'owner',
    agentId: 'agent-1',
    sessionKey: 'agent-1:conv-1',
    conversationId: 'conv-1',
    kind: 'user_message',
    origin: { type: 'user' },
    trusted: true,
    priority: 'user',
    payload: { text: 'hi' },
    at,
    status: 'accepted',
  };
  const input: RunInput = { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake] };
  const run: Run = {
    id: 'run-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    title: 'test',
    status: 'running',
    kind: 'chat',
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: at,
    lastActivityAt: at,
  };

  function servicesFor(store: Store, tool: Tool): RunServices {
    const registry: ToolRegistry = {
      forAgent: async () => [tool],
      get: (name) => (name === tool.name ? tool : undefined),
    };
    return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: new ScriptedModel(), toolRegistry: registry };
  }

  it('runs safe tools without a fence and re-runs them on a fresh retry', async () => {
    const store = createMemoryStore();
    await store.put('runs', run, { conversationId: run.conversationId });
    let executions = 0;
    const tool: Tool = {
      name: 'safe_effect',
      description: 'safe',
      parameters: {},
      replay: 'safe',
      sideEffect: false,
      execute: async () => {
        executions += 1;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };
    const services = servicesFor(store, tool);

    const ctx = runContext(['stp-safe']);
    await executeSingleToolCall(ctx, services, input, run.id, 0, 0, { id: 'call-1', name: 'safe_effect', arguments: {} });
    expect(executions).toBe(1);
    const steps = await store.list('steps', { limit: 10 });
    expect(steps.items[0]?.status).toBe('completed');
    expect(JSON.stringify(steps.items[0])).not.toContain('execution');

    // A fresh invocation retries a safe tool from scratch (no fence holds it back).
    await executeSingleToolCall(runContext(['stp-safe']), services, input, run.id, 1, 0, { id: 'call-1', name: 'safe_effect', arguments: {} });
    expect(executions).toBe(2);
  });

  it('treats a reused tool-call id in a later turn as a new step, not a recovery', async () => {
    const store = createMemoryStore();
    await store.put('runs', run, { conversationId: run.conversationId });
    let executions = 0;
    const tool: Tool = {
      name: 'effect',
      description: 'effect',
      parameters: {},
      replay: 'never',
      sideEffect: true,
      execute: async () => {
        executions += 1;
        return { content: [{ type: 'text', text: `run ${executions}` }] };
      },
    };
    const services = servicesFor(store, tool);
    const ctx = runContext(['stp-a', 'stp-b']);

    await executeSingleToolCall(ctx, services, input, run.id, 0, 0, { id: 'call-1', name: 'effect', arguments: {} });
    await executeSingleToolCall(ctx, services, input, run.id, 1, 0, { id: 'call-1', name: 'effect', arguments: {} });
    expect(executions).toBe(2);
  });
});

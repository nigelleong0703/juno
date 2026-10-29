import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import type { Brain, Store, ToolResult, WakeEvent } from '../../../contracts/index.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { requestScopedStore, runWithOwner } from '../../../owner-context.js';
import { agentDoc, conversationDoc } from '../../../execution/brain/__tests__/agent-resources.fixtures.js';
import { runWorkflowBody, type RunBodyContext } from '../services/run.js';
import { createEngineRegistry } from '../engines/registry.js';
import { createCompaction } from '../../brain/compaction.js';

const AT = '2026-10-20T00:00:00.000Z';

function wake(ownerId: string): WakeEvent {
  return {
    id: 'wake-1', ownerId, agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1',
    kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user',
    payload: { text: 'Search Notion for the launch notes' },
    at: AT, status: 'accepted',
  };
}

async function seeded() {
  const raw = createMemoryStore();
  const forOwner = raw.forOwner;
  if (!forOwner) throw new Error('owner-scoped store is required');
  const owner = forOwner('owner-1');
  await owner.put('agents', agentDoc('agent-1', []));
  await owner.put('conversations', conversationDoc('conv-1', ['agent-1']));
  return { raw, store: requestScopedStore(raw) };
}

function baseCtx(extra?: Partial<RunBodyContext>): RunBodyContext {
  let next = 0;
  return {
    key: 'run-disclosure',
    rand: { uuidv4: () => 'id-' + String((next += 1)) },
    run: (_name, action) => RestatePromise.resolve(action()),
    awakeable: <T>() => ({ id: 'awake', promise: RestatePromise.resolve(new Promise<T>(() => {})) }),
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
    cancel: { peek: async () => false, get: () => RestatePromise.resolve(new Promise<boolean>(() => {})) },
    runFinished: async () => {},
    ...extra,
  };
}

function stubBrain(): Brain {
  return {
    buildContext: async () => {
      return { sessionKey: 'agent-1:conv-1', agentId: 'agent-1' };
    },
    step: async () => ({ text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, stopReason: 'stop' }),
    shouldCompact: () => false,
    compact: async (context) => context,
  };
}

function stubEngines() {
  return createEngineRegistry([{ id: 'pi', name: 'stub', version: '1', available: true,
    capabilities: { tools: true, approvals: true, steering: true, deltas: false },
    executeTurn: async () => 'completed' as const,
  }]);
}

async function transcriptText(store: Store, sessionKey: string): Promise<string> {
  const page = await store.list('transcripts', { limit: 200 });
  return JSON.stringify(page.items.filter((entry) => entry.sessionKey === sessionKey));
}

describe('first-model tool disclosure', () => {
  it('prepares once before the first brain context and journals the note', async () => {
    const { store } = await seeded();
    const order: string[] = [];
    let seenInContext = '';
    const prepare = async (): Promise<ToolResult> => {
      order.push('prepare');
      return { content: [{ type: 'text', text: 'PREPARED-CATALOG-NOTE' }] };
    };
    const brain: Brain = {
      ...stubBrain(),
      buildContext: async () => {
        order.push('context');
        seenInContext = await transcriptText(store, 'agent-1:conv-1');
        return { sessionKey: 'agent-1:conv-1', agentId: 'agent-1' };
      },
    };
    const registry = { forAgent: async () => [], get: () => undefined, prepareForModel: prepare };
    await runWorkflowBody(baseCtx(), {
      store, brain, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
      toolRegistry: registry, engines: stubEngines(),
    }, { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake('owner-1')] });
    expect(order).toEqual(['prepare', 'context']);
    expect(seenInContext).toContain('PREPARED-CATALOG-NOTE');
  });

  it('keeps the old behavior when the registry has no prepare method', async () => {
    const { store } = await seeded();
    let contexts = 0;
    const brain: Brain = { ...stubBrain(), buildContext: async () => { contexts += 1; return { sessionKey: 'agent-1:conv-1', agentId: 'agent-1' }; } };
    const registry = { forAgent: async () => [], get: () => undefined };
    await runWorkflowBody(baseCtx(), {
      store, brain, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
      toolRegistry: registry, engines: stubEngines(),
    }, { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake('owner-1')] });
    expect(contexts).toBe(1);
    expect(await transcriptText(store, 'agent-1:conv-1')).not.toContain('tool discovery');
  });

  it('replays the journaled step instead of preparing twice', async () => {
    const { store } = await seeded();
    let calls = 0;
    const prepare = async (): Promise<ToolResult> => {
      calls += 1;
      return { content: [{ type: 'text', text: 'REPLAY-NOTE' }] };
    };
    const registry = { forAgent: async () => [], get: () => undefined, prepareForModel: prepare };
    const journal = new Map<string, unknown>();
    const replayCtx = (): RunBodyContext => baseCtx({
      run: ((name: string, action: () => Promise<unknown>) => {
        if (name !== 'tool-disclosure') return RestatePromise.resolve(action());
        if (journal.has(name)) return RestatePromise.resolve(journal.get(name));
        return RestatePromise.resolve(action().then((value) => { journal.set(name, value); return value; }));
      }) as RunBodyContext['run'],
    });
    const services = () => ({ store, brain: stubBrain(), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), toolRegistry: registry, engines: stubEngines() });
    const input = { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake('owner-1')] };
    await runWorkflowBody(replayCtx(), services(), input);
    await runWorkflowBody(replayCtx(), services(), input);
    expect(calls).toBe(1);
    const text = await transcriptText(store, 'agent-1:conv-1');
    expect(text.match(/REPLAY-NOTE/g)?.length).toBe(1);
  });

  it('stops cooperatively before preparing when the run is already cancelled', async () => {
    const { store } = await seeded();
    let calls = 0;
    const prepare = async (): Promise<ToolResult> => { calls += 1; return { content: [{ type: 'text', text: 'LATE' }] }; };
    const registry = { forAgent: async () => [], get: () => undefined, prepareForModel: prepare };
    const ctx = baseCtx({ cancel: { peek: async () => true, get: () => RestatePromise.resolve(new Promise<boolean>(() => {})) } });
    await runWorkflowBody(ctx, {
      store, brain: stubBrain(), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
      toolRegistry: registry, engines: stubEngines(),
    }, { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake('owner-1')] });
    expect(calls).toBe(0);
    expect((await store.get('runs', 'run-disclosure'))?.status).toBe('stopped');
  });

  it('stops on the durable race when preparation ignores the signal', async () => {
    const { store } = await seeded();
    let contexts = 0;
    const brain: Brain = { ...stubBrain(), buildContext: async () => { contexts += 1; return { sessionKey: 'agent-1:conv-1', agentId: 'agent-1' }; } };
    const prepare = (): Promise<ToolResult> => new Promise<ToolResult>(() => {});
    const registry = { forAgent: async () => [], get: () => undefined, prepareForModel: prepare };
    const ctx = baseCtx({ cancel: { peek: async () => false, get: () => RestatePromise.resolve(true) } });
    await runWorkflowBody(ctx, {
      store, brain, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
      toolRegistry: registry, engines: stubEngines(),
    }, { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake('owner-1')] });
    expect(contexts).toBe(0);
    expect((await store.get('runs', 'run-disclosure'))?.status).toBe('stopped');
    expect(await transcriptText(store, 'agent-1:conv-1')).not.toContain('tool discovery');
  });

  it('continues on the fixed fallback when preparation throws', async () => {
    const { store } = await seeded();
    let turns = 0;
    const engines = createEngineRegistry([{ id: 'pi', name: 'stub', version: '1', available: true,
      capabilities: { tools: true, approvals: true, steering: true, deltas: false },
      executeTurn: async () => { turns += 1; return 'completed' as const; },
    }]);
    const prepare = async (): Promise<ToolResult> => { throw new Error('ranker down'); };
    const registry = { forAgent: async () => [], get: () => undefined, prepareForModel: prepare };
    await runWorkflowBody(baseCtx(), {
      store, brain: stubBrain(), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
      toolRegistry: registry, engines,
    }, { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake('owner-1')] });
    expect(turns).toBe(1);
  });

  it('treats an empty preparation as switched-off and appends nothing', async () => {
    const { store } = await seeded();
    const prepare = async (): Promise<ToolResult> => ({ content: [] });
    const registry = { forAgent: async () => [], get: () => undefined, prepareForModel: prepare };
    await runWorkflowBody(baseCtx(), {
      store, brain: stubBrain(), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
      toolRegistry: registry, engines: stubEngines(),
    }, { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake('owner-1')] });
    expect(await transcriptText(store, 'agent-1:conv-1')).not.toContain('tool discovery');
  });

  it('rejects a foreign owner before any preparation', async () => {
    const { store } = await seeded();
    let calls = 0;
    const prepare = async (): Promise<ToolResult> => { calls += 1; return { content: [{ type: 'text', text: 'X' }] }; };
    const registry = { forAgent: async () => [], get: () => undefined, prepareForModel: prepare };
    await expect(runWorkflowBody(baseCtx(), {
      store, brain: stubBrain(), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
      toolRegistry: registry, engines: stubEngines(),
    }, { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake('owner-2')] })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it('journals the preparation as a user note without fake tool or system rows', async () => {
    const { store } = await seeded();
    const prepare = async (): Promise<ToolResult> => ({ content: [{ type: 'text', text: 'LOCAL-CATALOG' }] });
    const registry = { forAgent: async () => [], get: () => undefined, prepareForModel: prepare };
    await runWorkflowBody(baseCtx(), {
      store, brain: stubBrain(), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
      toolRegistry: registry, engines: stubEngines(),
    }, { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake('owner-1')] });
    const page = await store.list('transcripts', { limit: 200 });
    const roles = page.items.filter((e) => e.sessionKey === 'agent-1:conv-1').map((e) => e.message['role']);
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) expect(role).toBe('user');
  });

  it('runs a main without System One on the local catalog fallback', async () => {
    const { store } = await seeded();
    let seen: unknown = 'unset';
    const prepare = async (_query: string, context: { systemOne?: unknown }): Promise<ToolResult> => {
      seen = context.systemOne;
      return { content: [{ type: 'text', text: 'LOCAL-CATALOG' }], details: { namespaces: 3 } };
    };
    const registry = { forAgent: async () => [], get: () => undefined, prepareForModel: prepare };
    await runWorkflowBody(baseCtx(), {
      store, brain: stubBrain(), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
      toolRegistry: registry, engines: stubEngines(),
    }, { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake('owner-1')] });
    expect(seen).toBeUndefined();
    expect(await transcriptText(store, 'agent-1:conv-1')).toContain('LOCAL-CATALOG');
  });
});

describe('once-per-session namespace directory', () => {
  const run = async (store: Store, runKey: string, directoryKey: string, perRun?: string): Promise<void> => {
    const prepare = async (): Promise<ToolResult> => ({
      content: [{ type: 'text', text: 'DIRECTORY-' + directoryKey }, ...(perRun === undefined ? [] : [{ type: 'text' as const, text: perRun }])],
      details: { directoryKey },
    });
    const registry = { forAgent: async () => [], get: () => undefined, prepareForModel: prepare };
    await runWorkflowBody(baseCtx({ key: runKey }), {
      store, brain: stubBrain(), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
      toolRegistry: registry, engines: stubEngines(),
    }, { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake('owner-1')] });
  };
  const count = async (store: Store, needle: string): Promise<number> => (await transcriptText(store, 'agent-1:conv-1')).split(needle).length - 1;

  it('appends the directory on the first run, then only per-run suggestions while it is unchanged', async () => {
    const { store } = await seeded();
    await run(store, 'run-a', 'k1', 'SUGGEST-A');
    await run(store, 'run-b', 'k1', 'SUGGEST-B');
    await run(store, 'run-c', 'k1');
    expect(await count(store, 'DIRECTORY-k1')).toBe(1);
    expect(await count(store, 'SUGGEST-A')).toBe(1);
    expect(await count(store, 'SUGGEST-B')).toBe(1);
    expect(await count(store, 'tool discovery')).toBe(2);
  });

  it('re-sends the directory when the tool set changes', async () => {
    const { store } = await seeded();
    await run(store, 'run-a', 'k1');
    await run(store, 'run-b', 'k2');
    await run(store, 'run-c', 'k2');
    expect(await count(store, 'DIRECTORY-k1')).toBe(1);
    expect(await count(store, 'DIRECTORY-k2')).toBe(1);
  });

  it('re-sends the directory after a new compaction epoch', async () => {
    const { store } = await seeded();
    await run(store, 'run-a', 'k1');
    await runWithOwner('owner-1', () => store.put('compactions', createCompaction('agent-1:conv-1', 1, 'summary', 0)));
    await run(store, 'run-b', 'k1');
    expect(await count(store, 'DIRECTORY-k1')).toBe(2);
  });
});

describe('suggested tool definitions are sent once per compaction epoch', () => {
  // The preparer reports which definitions its note carried in full (`details.definedTools`) and is told which the model already holds.
  const told: string[][] = [];
  const run = async (store: Store, runKey: string, defined: string[]): Promise<void> => {
    const prepare = async (_query: string, _context: unknown, described?: ReadonlySet<string>): Promise<ToolResult> => {
      told.push([...(described ?? [])].sort());
      return { content: [{ type: 'text', text: 'DIRECTORY' }, { type: 'text', text: 'SUGGEST-' + runKey }], details: { directoryKey: 'k1', definedTools: defined } };
    };
    const registry = { forAgent: async () => [], get: () => undefined, prepareForModel: prepare };
    await runWorkflowBody(baseCtx({ key: runKey }), {
      store, brain: stubBrain(), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
      toolRegistry: registry, engines: stubEngines(),
    }, { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake('owner-1')] });
  };

  it('tells the preparer what earlier runs of the chat already described, and everything again after a compaction', async () => {
    told.length = 0;
    const { store } = await seeded();
    await run(store, 'run-a', ['web_search@a1', 'web_fetch@b2']);
    await run(store, 'run-b', ['web_crawl@c3']);
    await run(store, 'run-c', []);
    await runWithOwner('owner-1', () => store.put('compactions', createCompaction('agent-1:conv-1', 1, 'summary', 0)));
    await run(store, 'run-d', ['web_search@a1']);
    await run(store, 'run-e', []);
    expect(told).toEqual([
      [],
      ['web_fetch@b2', 'web_search@a1'],
      ['web_crawl@c3', 'web_fetch@b2', 'web_search@a1'],
      [],
      ['web_search@a1'],
    ]);
  });
});

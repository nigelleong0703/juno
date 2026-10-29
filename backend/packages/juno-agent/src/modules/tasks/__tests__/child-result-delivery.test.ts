/** CT-result regression: the REAL final-reply, send_message and boundary paths. A child run is a
 * silent work item: its final and its plain send_message store the canonical childResult on the
 * run row and emit run.updated — never a chat bubble, a user question or a bypassing tool call.
 * Replay does not double-deliver; a stop beats a pending result; top-level runs keep public chat.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { Store, Tool, ToolContext, ToolRegistry, WakeEvent } from '../../../contracts/index.js';
import type { Collection, Doc } from '../../../contracts/index.js';
import type { Run } from '@agent-desktop/public-contracts';
import { createSendFileTool } from '../../../modules/tools/tools/sendFile.js';
import { createMessageAgentTool } from '../../../modules/tools/tools/messageAgent.js';
import { createHandoffTool } from '../../../modules/tools/tools/handoff.js';
import { createConversationCreateTool } from '../../../modules/tools/tools/conversationCreate.js';
import type { RunContext, RunInput, RunServices } from '../../../execution/harness/services/run-types.js';
import { ScriptedModel } from '../../../execution/harness/testing/stubs.js';
import type { ToolCallContext } from '../../../execution/harness/services/tool-policy.js';
import { storeChildResult } from '../childDelivery.js';
import type { ChildRun } from '../childRead.js';
import { createPostToRoomTool } from '../../../modules/tools/tools/postToRoom.js';
import { createSendMessageTool } from '../../../modules/tools/tools/sendMessage.js';
import { executeSingleToolCall } from '../../../execution/harness/services/run-tools.js';
import { NEVER_CANCELLED } from '../../../execution/harness/services/cancel.js';
import { replyStep } from '../../../execution/harness/services/final-reply.js';
import { startEngineForRun, type RunStartContext } from '../../../execution/harness/services/run.js';
import { createEngineRegistry } from '../../../execution/harness/engines/registry.js';
import { createPiAdapter } from '../../../execution/harness/engines/pi.js';

const OWNER = 'owner-1';
const AGENT = 'agent-a';
const CONV = 'conv-1';
const PARENT = 'run-parent';
const CHILD = 'run-child-1';
const AT = '2026-10-08T00:00:00.000Z';

const wake: WakeEvent = {
  id: 'w', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV + '::child:' + CHILD,
  conversationId: CONV, kind: 'child_task', origin: { type: 'agent', id: PARENT, label: 'child task' },
  trusted: false, priority: 'peer', payload: {}, at: AT, status: 'accepted',
};
const runInput: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: wake.sessionKey, wakeEvents: [wake] };

function childDoc(overrides: Partial<Run> = {}): Run {
  return {
    id: CHILD, agentId: AGENT, conversationId: CONV, parentRunId: PARENT, title: 'child',
    status: 'running', kind: 'background', steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: AT, lastActivityAt: AT, ...overrides,
  };
}

async function seedChild(store: Store, overrides: Partial<Run> = {}): Promise<void> {
  await store.put('runs', childDoc(overrides), { runId: CHILD, conversationId: CONV, agentId: AGENT });
}

function toolCtx(store: Store): ToolContext {
  return {
    ownerId: OWNER, agentId: AGENT, conversationId: CONV, runId: CHILD, stepId: 'stp-1',
    store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), wake, step: async (_name, fn) => fn(),
    signal: new AbortController().signal,
  };
}

/** Journaled ctx: named runs replay their recorded results instead of re-running the action. */
function runCtx(): RunContext {
  const journal = new Map<string, unknown>();
  return {
    rand: { uuidv4: () => 'id' },
    run: <T,>(name: string, action: () => Promise<T>): RestatePromise<T> => {
      if (journal.has(name)) return RestatePromise.resolve(structuredClone(journal.get(name)) as T);
      return RestatePromise.resolve(action().then((value) => { journal.set(name, structuredClone(value)); return value; }));
    },
    awakeable: <T,>() => ({ id: 'awake', promise: RestatePromise.resolve(new Promise<T>(() => {})) }),
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
  };
}

function journalCtx(): ToolCallContext {
  return runCtx();
}

function single(tool: Tool): ToolRegistry {
  return {
    async forAgent() { return [tool]; },
    get: (name) => (name === tool.name ? tool : undefined),
  };
}

function plainServices(store: Store, tool: Tool): RunServices {
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: new ScriptedModel(), toolRegistry: single(tool) };
}

/** Agent row with owner + workspace, so the real tools would pass membership without the guard. */
function agentDoc(id: string): Record<string, unknown> {
  return {
    id, name: id, handle: id, avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 't', status: 'idle', section: 'Work', pinned: false, lastActivity: '',
    unreadCount: 0,
    model: { planner: { provider: 'scripted', model: 't' }, computer: { provider: 'scripted', model: 't' }, fast: { provider: 'scripted', model: 't' } },
    channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false },
    createdBy: OWNER, ownerId: OWNER, createdAt: AT, updatedAt: AT,
  };
}

/** Seeds the workspace, both agents and a room conversation the agent is a member of. */
async function seedRoomWorld(store: Store): Promise<void> {
  await store.put('agents', agentDoc(AGENT) as never);
  await store.put('agents', agentDoc('agent-peer') as never);
  await store.put('conversations', {
    id: CONV, kind: 'room', title: 'Room', agentIds: [AGENT, 'agent-peer'],
    memberIds: [OWNER], unreadCount: 0, lastItemAt: AT, createdAt: AT,
  });
}

/** A store whose canonical child read can be held mid-flight (for the abort-recheck test). */
function gateStore(inner: Store, gate: Promise<void>): Store {
  return {
    async get<C extends Collection>(collection: C, id: string): Promise<Doc<C> | null> {
      if (collection === 'runs' && id === CHILD) await gate;
      return inner.get(collection, id);
    },
    list: (collection, query) => inner.list(collection, query),
    put: (collection, doc, index) => inner.put(collection, doc, index),
    patch: (collection, id, update) => inner.patch(collection, id, update),
    delete: (collection, id) => inner.delete(collection, id),
    emit: (event) => inner.emit(event),
    tx: (fn) => inner.tx(fn),
  };
}

/** Journalled engine-start context: init replays its recorded snapshot instead of re-running. */
function starterCtx(): RunStartContext {
  let journaled: Awaited<ReturnType<Parameters<RunStartContext['runInit']>[0]>> | undefined;
  return {
    runInit: async (action) => {
      if (journaled !== undefined) return journaled;
      journaled = await action();
      return journaled;
    },
    runFail: async (action) => {
      await action();
    },
    releaseSession: async () => undefined,
  };
}

describe('child result delivery', () => {
  it('a child final stores the canonical childResult and emits run.updated, no chat bubble', async () => {
    const store = createMemoryStore();
    await seedChild(store);
    const result = await replyStep(runCtx(), plainServices(store, { ...single({ name: 'none' } as unknown as Tool).get('none')! }), runInput, 0, 'Child answer.', NEVER_CANCELLED, [], CHILD);
    expect(result).toBe('completed');
    expect((await store.get('runs', CHILD))?.childResult).toBe('Child answer.');
    expect((await store.list('items', { limit: 10 })).items).toHaveLength(0);
    const events = await store.eventBus.since(0);
    expect(events.some((entry) => entry.event.type === 'CUSTOM' && entry.event.name === 'juno.run.updated')).toBe(true);
  });

  it('replaying the same child final does not double-deliver', async () => {
    const store = createMemoryStore();
    await seedChild(store);
    const ctx = runCtx();
    const registry = single({ name: 'none' } as unknown as Tool);
    await replyStep(ctx, plainServices(store, registry.get('none')!), runInput, 0, 'Result.', NEVER_CANCELLED, [], CHILD);
    const again = await replyStep(ctx, plainServices(store, registry.get('none')!), runInput, 0, 'Result.', NEVER_CANCELLED, ['Result.'], CHILD);
    expect(again).toBe('completed');
    expect((await store.get('runs', CHILD))?.childResult).toBe('Result.');
    expect((await store.list('items', { limit: 10 })).items).toHaveLength(0);
  });

  it('a stop landing before the write stores nothing', async () => {
    const store = createMemoryStore();
    await seedChild(store);
    const cancelled = { ...NEVER_CANCELLED, state: { cancelled: true }, signal: new AbortController().signal };
    const registry = single({ name: 'none' } as unknown as Tool);
    const result = await replyStep(runCtx(), plainServices(store, registry.get('none')!), runInput, 0, 'Result.', cancelled, [], CHILD);
    expect(typeof result).toBe('symbol');
    expect((await store.get('runs', CHILD))?.childResult).toBeUndefined();
  });

  it('top-level final posting keeps the user-visible bubble', async () => {
    const store = createMemoryStore();
    await store.put('runs', { id: PARENT, agentId: AGENT, conversationId: CONV, title: 'top', status: 'running', kind: 'chat', steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT });
    const registry = single({ name: 'none' } as unknown as Tool);
    const result = await replyStep(runCtx(), plainServices(store, registry.get('none')!), runInput, 0, 'Public answer.', NEVER_CANCELLED, [], PARENT);
    expect(result).toBe('completed');
    const items = (await store.list('items', { limit: 10 })).items;
    expect(items).toHaveLength(1);
    expect((await store.get('runs', PARENT))?.childResult).toBeUndefined();
  });

  it('a child plain send_message stores its result; a targeted one is refused before delivery', async () => {
    const store = createMemoryStore();
    await seedChild(store);
    const tool = createSendMessageTool({ store, enqueuer: new NoopEnqueuer() });
    const plain = await tool.execute({ kind: 'text', text: 'Direct child answer.' }, toolCtx(store));
    expect(plain.isError).not.toBe(true);
    expect((await store.get('runs', CHILD))?.childResult).toBe('Direct child answer.');
    expect((await store.list('items', { limit: 10 })).items).toHaveLength(0);
    const routed = await tool.execute({ kind: 'text', text: 'Bypass.', targetAgentIds: ['peer'], conversationId: CONV }, toolCtx(store));
    expect(routed.isError).toBe(true);
    expect(JSON.stringify(routed.content)).toContain('silent work items');
    expect((await store.list('items', { limit: 10 })).items.filter((item) => item.conversationId === CONV)).toHaveLength(0);
  });

  it('a child question never creates a human request', async () => {
    const store = createMemoryStore();
    await seedChild(store);
    const tool = createSendMessageTool({ store, enqueuer: new NoopEnqueuer() });
    const q = await tool.execute({ kind: 'question', text: 'What size?' }, toolCtx(store));
    expect(q.isError).toBe(true);
    expect((await store.list('requests', { limit: 5 })).items).toHaveLength(0);
  });

  it('child outbound post_to_room is refused through the real harness before any effect', async () => {
    const store = createMemoryStore();
    await seedChild(store);
    const tool = createPostToRoomTool({ store, enqueuer: new NoopEnqueuer() });
    const outcome = await executeSingleToolCall(journalCtx(), plainServices(store, tool), runInput, CHILD, 0, 0, { id: 'c1', name: 'post_to_room', arguments: { roomId: 'room-x', message: 'bypass' } }, NEVER_CANCELLED, []);
    expect(outcome === undefined).toBe(false);
    if (outcome === undefined) return;
    if (typeof outcome === 'symbol') throw new Error('expected a refusal outcome');
    expect(JSON.stringify(outcome.result.content)).toContain('silent work items');
    expect((await store.list('items', { limit: 20 })).items.filter((item) => item.conversationId === 'room-x')).toHaveLength(0);
  });

  it('run-engine rebuild preserves childResult across init and finalize', async () => {
    const store = createMemoryStore();
    await seedChild(store);
    await store.patch('runs', CHILD, { childResult: 'Kept.' });
    const registry = createEngineRegistry([createPiAdapter()]);
    await startEngineForRun(starterCtx(), store, registry, null, runInput, CHILD, { peek: async () => false });
    expect((await store.get('runs', CHILD))?.childResult).toBe('Kept.');
  });

  it('storeChildResult refuses a foreign or missing canonical row', async () => {
    const store = createMemoryStore();
    expect(await storeChildResult({ store }, { runId: 'run-missing', agentId: AGENT, conversationId: CONV, text: 'x' })).toBe(false);
    await store.put('runs', { ...childDoc(), parentRunId: undefined }, { runId: CHILD });
    expect(await storeChildResult({ store }, { runId: CHILD, agentId: AGENT, conversationId: CONV, text: 'x' })).toBe(false);
    expect((await store.get('runs', CHILD))?.childResult).toBeUndefined();
  });

  it('child send_file, message_agent, handoff and conversation_create are refused before effects', async () => {
    const store = createMemoryStore();
    await seedRoomWorld(store);
    await seedChild(store);
    const enqueuer = new NoopEnqueuer();
    const attempts: Array<{ tool: Tool; args: Record<string, unknown> }> = [
      { tool: createSendFileTool({ store }), args: { path: 'a.txt' } },
      { tool: createMessageAgentTool({ store, enqueuer }), args: { target: 'agent-peer', message: 'bypass' } },
      { tool: createHandoffTool({ store, enqueuer }), args: { roomId: CONV, to: 'agent-peer', task: 'bypass' } },
      { tool: createConversationCreateTool({ store }), args: { title: 'sneaky room', memberAgentIds: [AGENT, 'agent-peer'] } },
    ];
    for (const attempt of attempts) {
      const outcome = await executeSingleToolCall(journalCtx(), plainServices(store, attempt.tool), runInput, CHILD, 0, 0, { id: 'c1', name: attempt.tool.name, arguments: attempt.args }, NEVER_CANCELLED, []);
      expect(outcome === undefined).toBe(false);
      if (outcome === undefined) continue;
      if (typeof outcome === 'symbol') throw new Error('expected a refusal outcome');
      expect(JSON.stringify(outcome.result.content)).toContain('silent work items');
    }
    // The real tools would have written items, a peer conversation, a new room or library rows;
    // the boundary refused every one before any of those effects.
    expect(enqueuer.calls).toHaveLength(0);
    expect((await store.list('items', { limit: 50 })).items).toHaveLength(0);
    expect((await store.list('library', { limit: 50 })).items).toHaveLength(0);
    const rooms = (await store.list('conversations', { limit: 50 })).items.filter((room) => room.kind !== 'room' || room.id !== CONV);
    expect(rooms).toHaveLength(0);
  });

  it('the same outbound tools stay runnable for a top-level run (child scope only)', async () => {
    const store = createMemoryStore();
    await seedRoomWorld(store);
    const top = 'run-top';
    await store.put('runs', { id: top, agentId: AGENT, conversationId: CONV, title: 'top', status: 'running', kind: 'chat', steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT });
    const tool = createPostToRoomTool({ store, enqueuer: new NoopEnqueuer() });
    const ctx = { ...toolCtx(store), runId: top, stepId: 'stp-top' };
    const posted = await tool.execute({ roomId: CONV, message: 'Room post.' }, ctx);
    expect(posted.isError).not.toBe(true);
    expect((await store.list('items', { limit: 50 })).items.some((item) => item.conversationId === CONV)).toBe(true);
  });

  it('an abort during the canonical read leaves no result (recheck before the patch)', async () => {
    const inner = createMemoryStore();
    await seedChild(inner);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = gateStore(inner, gate);
    const controller = new AbortController();
    const pending = storeChildResult({ store }, { runId: CHILD, agentId: AGENT, conversationId: CONV, text: 'late result' }, { state: { cancelled: false }, signal: controller.signal });
    controller.abort();
    release();
    expect(await pending).toBe(false);
    expect((await inner.get('runs', CHILD))?.childResult).toBeUndefined();
  });

  it('keeps a result longer than the stored head whole in an artifact the parent can read', async () => {
    const store = createMemoryStore();
    await seedChild(store);
    const long = 'x'.repeat(5_000);
    expect(await storeChildResult({ store }, { runId: CHILD, agentId: AGENT, conversationId: CONV, text: long })).toBe(true);
    const row: ChildRun | null = await store.get('runs', CHILD);
    expect(row?.childResult).toHaveLength(4_000);
    const ref = String(row?.childResultRef);
    expect((await store.get('artifacts', ref))?.text).toHaveLength(5_000);
  });
});

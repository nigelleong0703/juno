/** CT-parent: the model-facing child_cancel tool — real authorization (agent/conversation/owner),
 * a real stop dispatch through the current ctx enqueuer, truthful idempotent terminal behavior and
 * the pinned neutral-prompt regressions. Deterministic: memory store, recording enqueuer. */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import type { Enqueuer, Store, Tool, ToolContext, ToolRegistry, ToolResult, WakeEvent } from '../../../contracts/index.js';
import type { Agent, Conversation, Run } from '@agent-desktop/public-contracts';
import { createToolRegistry } from '../../tools/index.js';
import { spawnChildTask, type ChildDispatchAdapter } from '../child.js';
import { readTranscript } from '../../../execution/brain/transcript.js';
import { resolveAdmittedOwner } from '../../../execution/execution-owner.js';
import { childSessionKey, type ChildRun } from '../childRead.js';
import { authorizeOwnChild } from '../childControl.js';
import { createTaskStopTool } from '../../tools/tools/taskTools.js';

const OWNER = 'owner-1';
const AGENT = 'agent-a';
const CONV = 'conv-parent';
const PARENT = 'run-parent';
const STEP = 'stp-1';
const AT = '2026-10-08T00:00:00.000Z';
const usage = { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 };

const wake: WakeEvent = {
  id: 'w', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV,
  kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, at: AT, status: 'accepted',
};

/** Records every stopRun; failNext fails the next dispatch like an unavailable Restate ingress. */
class RecordingEnqueuer implements Enqueuer {
  readonly stopped: string[] = [];
  failNext = false;
  /** Optional racing canceller effect, e.g. the run's own canceller flipping the row terminal. */
  onStop?: (runId: string) => Promise<void>;
  async enqueue(): Promise<{ accepted: boolean }> { return { accepted: true }; }
  async stopRun(runId: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('restate ingress unavailable');
    }
    if (this.onStop !== undefined) await this.onStop(runId);
    this.stopped.push(runId);
  }
  async resolveAwakeable(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
}

class RecordingAdapter implements ChildDispatchAdapter {
  readonly started: string[] = [];
  async startChildRun(input: { runId: string }): Promise<void> { this.started.push(input.runId); }
}

function firstText(result: ToolResult): string {
  const part = result.content[0];
  return part !== undefined && part.type === 'text' ? part.text : '';
}

function ctxFor(store: Store, enqueuer: Enqueuer): ToolContext {
  return { ownerId: OWNER, agentId: AGENT, conversationId: CONV, runId: PARENT, stepId: STEP, store, blobs: createMemoryBlobStore(), enqueuer, wake, step: async (_name, fn) => fn(), signal: new AbortController().signal };
}

async function registryFor(store: Store, enqueuer: Enqueuer): Promise<ToolRegistry> {
  return createToolRegistry({ store, enqueuer });
}

async function cancelTool(store: Store, enqueuer: Enqueuer): Promise<Tool> {
  const registry = await registryFor(store, enqueuer);
  const tool = registry.get('child_cancel');
  if (tool === undefined) throw new Error('child_cancel is not registered');
  return tool;
}

/** The real spawn path, so the cancelled child is a genuinely linked and dispatched run. */
async function spawnOwnChild(store: Store): Promise<string> {
  const spawned = await spawnChildTask(store, {
    ownerId: OWNER, agentId: AGENT, parentRunId: PARENT, conversationId: CONV, callId: STEP,
    prompt: 'summarize the inbox', targetAgentId: AGENT,
  }, new RecordingAdapter());
  if (!spawned.ok) throw new Error('spawn refused: ' + spawned.reason);
  return spawned.child.runId;
}

function agentRecord(): Agent {
  return { id: AGENT, name: AGENT, handle: AGENT, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 't', status: 'idle', section: 'Work', pinned: false, lastActivity: '', unreadCount: 0, model: { planner: { provider: 'scripted', model: 't' }, computer: { provider: 'scripted', model: 't' }, fast: { provider: 'scripted', model: 't' } }, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdBy: OWNER, createdAt: AT, updatedAt: AT };
}

function conversationRecord(): Conversation {
  return { id: CONV, kind: 'direct', title: 'p', agentIds: [AGENT], memberIds: [OWNER], unreadCount: 0, lastItemAt: AT, createdAt: AT };
}

function runDoc(input: { id: string; parentRunId: string }): Run {
  return { id: input.id, agentId: AGENT, conversationId: CONV, parentRunId: input.parentRunId, title: 'child', status: 'queued', kind: 'background', steps: [], usage, startedAt: AT, lastActivityAt: AT };
}

async function seedWorld(store: Store, seedOwner: string = OWNER): Promise<void> {
  // Rows are seeded through the seed owner's scoped facade: the store layer force-stamps the
  // doc with that ownerId, so a mismatched parent owner can actually be seeded for refusal tests.
  const scoped = store.forOwner === undefined ? store : store.forOwner(seedOwner);
  await scoped.put('agents', agentRecord());
  await scoped.put('conversations', conversationRecord());
  await scoped.put('runs', { id: PARENT, agentId: AGENT, conversationId: CONV, title: 'parent', status: 'running', kind: 'chat', steps: [], usage, startedAt: AT, lastActivityAt: AT }, { agentId: AGENT, conversationId: CONV });
}

describe('child_cancel tool (CT-parent)', () => {

  it('refuses a foreign child and the run itself, dispatching no stop', async () => {
    const store = createMemoryStore();
    await seedWorld(store);
    const scoped = store.forOwner === undefined ? store : store.forOwner(OWNER);
    await scoped.put('runs', runDoc({ id: 'run-foreign-child', parentRunId: 'run-other' }), { agentId: AGENT, conversationId: CONV });
    const enqueuer = new RecordingEnqueuer();
    const cancel = await cancelTool(store, enqueuer);
    const foreign = await cancel.execute({ runId: 'run-foreign-child' }, ctxFor(store, enqueuer));
    expect(foreign.isError).toBe(true);
    expect(firstText(foreign)).toContain('not a child of this run');
    const self = await cancel.execute({ runId: PARENT }, ctxFor(store, enqueuer));
    expect(self.isError).toBe(true);
    expect(enqueuer.stopped).toEqual([]);
  });

  it('refuses when the parent run does not match the calling agent or owner', async () => {
    const agentStore = createMemoryStore();
    await seedWorld(agentStore);
    const agentScoped = agentStore.forOwner === undefined ? agentStore : agentStore.forOwner(OWNER);
    await agentStore.patch('runs', PARENT, { agentId: 'agent-b' });
    await agentScoped.put('runs', runDoc({ id: 'run-child-agent', parentRunId: PARENT }), { agentId: AGENT, conversationId: CONV });
    const agentEnqueuer = new RecordingEnqueuer();
    const agentCancel = await cancelTool(agentStore, agentEnqueuer);
    const agentResult = await agentCancel.execute({ runId: 'run-child-agent' }, ctxFor(agentStore, agentEnqueuer));
    expect(agentResult.isError).toBe(true);

    const ownerStore = createMemoryStore();
    await seedWorld(ownerStore, 'owner-2');
    const ownerScoped = ownerStore.forOwner === undefined ? ownerStore : ownerStore.forOwner(OWNER);
    await ownerScoped.put('runs', runDoc({ id: 'run-child-owner', parentRunId: PARENT }), { agentId: AGENT, conversationId: CONV });
    const ownerEnqueuer = new RecordingEnqueuer();
    const ownerCancel = await cancelTool(ownerStore, ownerEnqueuer);
    const ownerResult = await ownerCancel.execute({ runId: 'run-child-owner' }, ctxFor(ownerStore, ownerEnqueuer));
    expect(ownerResult.isError).toBe(true);
    expect(agentEnqueuer.stopped).toEqual([]);
    expect(ownerEnqueuer.stopped).toEqual([]);
  });

  it('reports an already-terminal child without dispatching anything, idempotently', async () => {
    const store = createMemoryStore();
    await seedWorld(store);
    const enqueuer = new RecordingEnqueuer();
    const childId = await spawnOwnChild(store);
    await store.patch('runs', childId, { status: 'completed', finishedAt: AT });
    const cancel = await cancelTool(store, enqueuer);
    const first = await cancel.execute({ runId: childId }, ctxFor(store, enqueuer));
    expect(first.isError ?? false).toBe(false);
    expect(firstText(first)).toContain('already ended');
    expect(firstText(first)).toContain('completed');
    expect(enqueuer.stopped).toEqual([]);
    const again = await cancel.execute({ runId: childId }, ctxFor(store, enqueuer));
    expect(firstText(again)).toContain('already ended');
    expect(enqueuer.stopped).toEqual([]);
  });

  it('dispatches the real stop through ctx.enqueuer.stopRun and never patches the status', async () => {
    const store = createMemoryStore();
    await seedWorld(store);
    const enqueuer = new RecordingEnqueuer();
    const childId = await spawnOwnChild(store);
    const cancel = await cancelTool(store, enqueuer);
    const result = await cancel.execute({ runId: childId }, ctxFor(store, enqueuer));
    expect(result.isError ?? false).toBe(false);
    expect(enqueuer.stopped).toEqual([childId]);
    expect(firstText(result)).toContain('Cancellation requested');
    const row = await store.get('runs', childId);
    expect(row?.status).toBe('queued');
    const again = await cancel.execute({ runId: childId }, ctxFor(store, enqueuer));
    expect(firstText(again)).toContain('Cancellation requested');
    expect(enqueuer.stopped).toEqual([childId, childId]);
  });

  it('reports a failed stop without fabricating a status', async () => {
    const store = createMemoryStore();
    await seedWorld(store);
    const enqueuer = new RecordingEnqueuer();
    enqueuer.failNext = true;
    const childId = await spawnOwnChild(store);
    const cancel = await cancelTool(store, enqueuer);
    const result = await cancel.execute({ runId: childId }, ctxFor(store, enqueuer));
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('failed');
    const row = await store.get('runs', childId);
    expect(row?.status).toBe('queued');
    expect(enqueuer.stopped).toEqual([]);
  });

  it("reports the run's own terminal state when a completion races the cancel", async () => {
    const store = createMemoryStore();
    await seedWorld(store);
    const enqueuer = new RecordingEnqueuer();
    enqueuer.onStop = async (runId) => {
      await store.patch('runs', runId, { status: 'completed', finishedAt: AT });
    };
    const childId = await spawnOwnChild(store);
    const cancel = await cancelTool(store, enqueuer);
    const result = await cancel.execute({ runId: childId }, ctxFor(store, enqueuer));
    expect(result.isError ?? false).toBe(false);
    expect(firstText(result)).toContain('completed');
    expect(firstText(result)).not.toContain('stopped');
  });
});

describe('child_message tool', () => {
  async function messageTool(store: Store, enqueuer: Enqueuer, adapter: RecordingAdapter): Promise<Tool> {
    const tool = (await createToolRegistry({ store, enqueuer, childDispatch: adapter })).get('child_message');
    if (tool === undefined) throw new Error('child_message is not registered');
    return tool;
  }

  it('refuses a child this run does not own and dispatches nothing', async () => {
    const store = createMemoryStore();
    await seedWorld(store);
    const scoped = store.forOwner === undefined ? store : store.forOwner(OWNER);
    await scoped.put('runs', runDoc({ id: 'run-foreign-child', parentRunId: 'run-other' }), { agentId: AGENT, conversationId: CONV });
    const enqueuer = new RecordingEnqueuer();
    const adapter = new RecordingAdapter();
    const result = await (await messageTool(store, enqueuer, adapter)).execute({ runId: 'run-foreign-child', text: 'hi' }, ctxFor(store, enqueuer));
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('not a child of this run');
    expect(adapter.started).toEqual([]);
  });

  it('steers a running child through its own session with the parent as the origin', async () => {
    const store = createMemoryStore();
    await seedWorld(store);
    const enqueuer = new RecordingEnqueuer();
    const adapter = new RecordingAdapter();
    // The owner-scoped facade stamps the child row, as production writes do.
    const scoped = store.forOwner === undefined ? store : store.forOwner(OWNER);
    const spawned = await spawnChildTask(scoped, { ownerId: OWNER, agentId: AGENT, parentRunId: PARENT, conversationId: CONV, callId: STEP, prompt: 'scan', targetAgentId: AGENT }, adapter);
    if (!spawned.ok) throw new Error('spawn refused: ' + spawned.reason);
    const seen: Array<{ wake: WakeEvent; mode: unknown }> = [];
    enqueuer.enqueue = (async (event: WakeEvent, opts?: unknown) => { seen.push({ wake: event, mode: opts }); return { accepted: true }; }) as unknown as typeof enqueuer.enqueue;
    const result = await (await messageTool(store, enqueuer, adapter)).execute({ runId: spawned.child.runId, text: 'also check X' }, ctxFor(store, enqueuer));
    expect(result.isError).toBeFalsy();
    expect(adapter.started).toHaveLength(1);
    expect(seen).toHaveLength(1);
    const [entry] = seen;
    expect(entry?.wake.sessionKey).toBe(childSessionKey(AGENT, CONV, spawned.child.runId));
    expect(entry?.wake.mode).toBe('steer');
    expect(entry?.wake.kind).toBe('child_task');
    expect(entry?.wake.origin.type).toBe('system');
    expect(entry?.wake.payload).toMatchObject({ prompt: 'also check X', childRunId: spawned.child.runId, parentRunId: PARENT });
    // The child session admits the steer only for its own run, parent and owner.
    expect(await resolveAdmittedOwner(store, [entry!.wake], { agentId: AGENT, conversationId: CONV, sessionKey: entry!.wake.sessionKey })).toEqual({ ownerId: OWNER });
  });

  it('continues a finished child as a new run seeded with its earlier transcript', async () => {
    const store = createMemoryStore();
    await seedWorld(store);
    const enqueuer = new RecordingEnqueuer();
    const adapter = new RecordingAdapter();
    const spawned = await spawnChildTask(store, { ownerId: OWNER, agentId: AGENT, parentRunId: PARENT, conversationId: CONV, callId: STEP, prompt: 'scan', targetAgentId: AGENT, tools: ['web_fetch'] }, adapter);
    if (!spawned.ok) throw new Error('spawn refused: ' + spawned.reason);
    const oldKey = childSessionKey(AGENT, CONV, spawned.child.runId);
    await store.put('transcripts', { id: 'tx-old', sessionKey: oldKey, seq: 0, message: { role: 'user', content: 'scan the inbox', timestamp: 0 }, compactionEpoch: 0, at: AT });
    await store.patch('runs', spawned.child.runId, { status: 'completed', childResult: 'found 3' });
    const result = await (await messageTool(store, enqueuer, adapter)).execute({ runId: spawned.child.runId, text: 'now the drafts' }, ctxFor(store, enqueuer));
    expect(result.isError).toBeFalsy();
    const continued = result.details?.['continued'];
    expect(continued).toBe(spawned.child.runId);
    const newRunId = adapter.started[adapter.started.length - 1];
    expect(newRunId).not.toBe(spawned.child.runId);
    const row = await store.get('runs', String(newRunId));
    expect(row).toMatchObject({ continues: spawned.child.runId, allowedTools: ['web_fetch'], childPrompt: 'now the drafts' });
    const copied = await readTranscript(store, childSessionKey(AGENT, CONV, String(newRunId)));
    expect(copied.map((entry) => entry.message)).toMatchObject([{ role: 'user', content: 'scan the inbox' }]);
  });
});

describe('child budget shares the parent remainder', () => {
  it('a later sibling inherits only what earlier children have not spent', async () => {
    const store = createMemoryStore();
    await seedWorld(store);
    await store.patch('runs', PARENT, { executionBudget: { limits: { costUsd: 1 }, explicitCost: true } } as Partial<ChildRun>);
    const adapter = new RecordingAdapter();
    const first = await spawnChildTask(store, { ownerId: OWNER, agentId: AGENT, parentRunId: PARENT, conversationId: CONV, callId: 'stp-a', prompt: 'one', targetAgentId: AGENT }, adapter);
    if (!first.ok) throw new Error('first spawn refused: ' + first.reason);
    await store.patch('runs', first.child.runId, { usage: { ...usage, costUsd: 0.9 } });
    const second = await spawnChildTask(store, { ownerId: OWNER, agentId: AGENT, parentRunId: PARENT, conversationId: CONV, callId: 'stp-b', prompt: 'two', targetAgentId: AGENT }, adapter);
    if (!second.ok) throw new Error('second spawn refused: ' + second.reason);
    const row: ChildRun | null = await store.get('runs', second.child.runId);
    expect(row?.budgetSnapshot?.limits.costUsd).toBeCloseTo(0.1, 6);
  });
});

/** Ownership is a security boundary: the pure rule shared by child_message, child_cancel, task_stop, child_results and child_wait. */
describe('authorizeOwnChild ownership rule', () => {
  const EARLIER = '2026-10-07T00:00:00.000Z';
  const LATER = '2026-10-09T00:00:00.000Z';
  function runRow(id: string, over: Partial<Run & { ownerId: string; parentRunId: string }> = {}): Run & { ownerId: string } {
    return {
      id, agentId: AGENT, conversationId: CONV, title: id, status: 'running', kind: 'background', steps: [],
      usage, startedAt: AT, lastActivityAt: AT, ownerId: OWNER, ...over,
    } as Run & { ownerId: string };
  }
  async function world(): Promise<Store> {
    const store = createMemoryStore();
    await store.put('runs', runRow(PARENT) as never, { conversationId: CONV });
    // An earlier run of the same agent, conversation and owner spawned this child.
    await store.put('runs', runRow('run-earlier', { startedAt: EARLIER }) as never, { conversationId: CONV });
    await store.put('runs', runRow('child-earlier', { parentRunId: 'run-earlier' }) as never, { conversationId: CONV });
    await store.put('runs', runRow('child-own', { parentRunId: PARENT }) as never, { conversationId: CONV });
    await store.put('runs', runRow('child-sibling', { parentRunId: PARENT }) as never, { conversationId: CONV });
    await store.put('runs', runRow('grandchild-own', { parentRunId: 'child-own' }) as never, { conversationId: CONV });
    await store.put('runs', runRow('run-other-agent', { agentId: 'agent-b', startedAt: EARLIER }) as never, { conversationId: CONV });
    await store.put('runs', runRow('child-other-agent', { parentRunId: 'run-other-agent' }) as never, { conversationId: CONV });
    await store.put('runs', runRow('run-other-conv', { conversationId: 'conv-other', startedAt: EARLIER }) as never, { conversationId: 'conv-other' });
    await store.put('runs', runRow('child-other-conv', { parentRunId: 'run-other-conv' }) as never, { conversationId: CONV });
    await store.put('runs', runRow('run-other-owner', { ownerId: 'owner-2', startedAt: EARLIER }) as never, { conversationId: CONV });
    await store.put('runs', runRow('child-other-owner', { parentRunId: 'run-other-owner' }) as never, { conversationId: CONV });
    await store.put('runs', runRow('run-late', { startedAt: LATER }) as never, { conversationId: CONV });
    await store.put('runs', runRow('child-late', { parentRunId: 'run-late' }) as never, { conversationId: CONV });
    return store;
  }
  const access = (store: Store, childRunId: string, callerRunId = PARENT) =>
    authorizeOwnChild(store, { ownerId: OWNER, agentId: AGENT, parentRunId: callerRunId, childRunId, conversationId: CONV });

  it('allows the caller own child and a child of an earlier run of the same agent, conversation and owner', async () => {
    const store = await world();
    expect((await access(store, 'child-own')).ok).toBe(true);
    expect((await access(store, 'child-earlier')).ok).toBe(true);
  });

  it('refuses a child run its own siblings and the earlier-spawner children, but still allows its own children', async () => {
    const store = await world();
    // child-own is a child run of PARENT; its siblings were spawned by PARENT (earlier, same agent/conversation/owner).
    expect(await access(store, 'child-sibling', 'child-own')).toEqual({ ok: false, reason: 'not_own_child' });
    expect(await access(store, 'child-earlier', 'child-own')).toEqual({ ok: false, reason: 'not_own_child' });
    expect((await access(store, 'grandchild-own', 'child-own')).ok).toBe(true);
  });

  it('refuses task_stop on a sibling from a child run, and allows task_stop on the child run\'s own child', async () => {
    const store = await world();
    const stopped: string[] = [];
    const stopTask = (callerRunId: string, taskId: string) => {
      const ctx = {
        store, ownerId: OWNER, agentId: AGENT, conversationId: CONV, runId: callerRunId,
        enqueuer: { stopRun: async (runId: string) => { stopped.push(runId); } },
      } as unknown as ToolContext;
      return createTaskStopTool({}).execute({ taskId }, ctx);
    };
    expect((await stopTask('child-own', 'child-sibling')).isError).toBe(true);
    expect((await stopTask('child-own', 'child-earlier')).isError).toBe(true);
    expect(stopped).toEqual([]);
    expect((await stopTask('child-own', 'grandchild-own')).isError).not.toBe(true);
    expect(stopped).toEqual(['grandchild-own']);
  });

  it('refuses another agent, another conversation, another owner and a spawner that started after the caller', async () => {
    const store = await world();
    for (const childRunId of ['child-other-agent', 'child-other-conv', 'child-other-owner', 'child-late']) {
      expect(await access(store, childRunId), childRunId).toEqual({ ok: false, reason: 'not_own_child' });
    }
    // Refused for an unknown id too, and a run cannot be its own child.
    expect(await access(store, 'child-missing')).toEqual({ ok: false, reason: 'not_own_child' });
    expect(await access(store, PARENT)).toEqual({ ok: false, reason: 'not_own_child' });
  });
});

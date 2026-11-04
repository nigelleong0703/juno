/** PH12 child workflow: reserved children run end to end and stop really. */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { DurablePromise } from '@agent-desktop/durable';
import { createMemoryStore } from '../../../testing/store.js';
import type { AssistantTurn, Brain, BrainContext, SubagentRunStart, Enqueuer, Store, ToolRegistry, WakeEvent } from '../../../contracts/index.js';
import { subagentRunInput } from '../../subagent-run-input';
import { createSendMessageTool } from '../../../modules/tools/tools/sendMessage.js';
import { startSubagent, type SubagentRun } from '../../../modules/tasks/subagent.js';
import { canonicalPlanId } from '../../../modules/tasks/state.js';
import { createEngineRegistry } from '../engines/registry.js';
import { NEVER_CANCELLED } from '../services/cancel.js';
import { defaultRegistry } from '../services/run-engine.js';
import { runWorkflowBody, startEngineForRun, type RunBodyContext, type RunStartContext } from '../services/run.js';
import type { RunContext } from '../services/run-types.js';
const AT = '2026-10-08T00:00:00.000Z';
const OWNER = 'owner-1';
const AGENT = 'agent-a';
const CONV = 'conv-1';
const PARENT = 'run-parent';
const PSESS = AGENT + ':' + CONV;
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };
class ScriptedTurns implements Brain {
  private index = 0;
  constructor(private readonly turns: AssistantTurn[]) {}
  async buildContext(): Promise<BrainContext> { return { sessionKey: PSESS, agentId: AGENT }; }
  async step(): Promise<AssistantTurn> {
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)];
    this.index += 1;
    if (turn === undefined) throw new Error('no scripted turn');
    return turn;
  }
  shouldCompact(): boolean { return false; }
  async compact(ctx: BrainContext): Promise<BrainContext> { return ctx; }
}
function sendText(text: string): AssistantTurn { return { text: '', toolCalls: [{ id: 's1', name: 'send_message', arguments: { kind: 'text', purpose: 'result', text } }], usage, stopReason: 'tool_calls' }; }
function final(text: string): AssistantTurn { return { text, toolCalls: [], usage, stopReason: 'stop' }; }
class RecordingEnqueuer implements Enqueuer {
  stops: string[] = [];
  starts: SubagentRunStart[] = [];
  async enqueue(): Promise<{ accepted: boolean }> { return { accepted: true }; }
  async stopRun(runId: string): Promise<void> { this.stops.push(runId); }
  async resolveAwakeable(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
  async startSubagentRun(input: SubagentRunStart): Promise<void> { this.starts.push(input); }
}
function registryWith(store: Store, enqueuer: Enqueuer): ToolRegistry {
  const tools = [createSendMessageTool({ store, enqueuer })];
  return { forAgent: async () => tools, get: (name) => tools.find((tool) => tool.name === name) };
}
function rootWake(): WakeEvent { return { id: 'wake-parent', ownerId: OWNER, agentId: AGENT, sessionKey: PSESS, conversationId: CONV, kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: 'go' }, at: AT, status: 'accepted' }; }
async function seedParent(store: Store): Promise<void> {
  await store.put('agents', { id: AGENT, name: AGENT, handle: AGENT, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 't', status: 'idle', section: 'Work', pinned: false, lastActivity: '', unreadCount: 0, model: { planner: { provider: 'scripted', model: 't' }, computer: { provider: 'scripted', model: 't' }, fast: { provider: 'scripted', model: 't' } }, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdAt: AT, updatedAt: AT });
  await store.put('conversations', { id: CONV, kind: 'direct', agentIds: [AGENT], memberIds: [], unreadCount: 0, lastItemAt: AT, createdAt: AT });
  await store.put('runs', { id: PARENT, agentId: AGENT, conversationId: CONV, title: 'parent', status: 'running', kind: 'chat', steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT, childRunIds: [] });
}
async function reserve(store: Store, enqueuer: RecordingEnqueuer, prompt: string): Promise<SubagentRunStart> {
  const spawned = await startSubagent(store, { ownerId: OWNER, agentId: AGENT, parentRunId: PARENT, conversationId: CONV, callId: 'stp-1', prompt, targetAgentId: AGENT }, { startSubagentRun: async (input) => { enqueuer.starts.push(input); } });
  if (!spawned.ok) throw new Error('reserve failed: ' + spawned.reason);
  const started = enqueuer.starts[enqueuer.starts.length - 1];
  if (started === undefined) throw new Error('no start recorded');
  return started;
}
function subagentRow(runId: string, status: 'running' | 'completed'): SubagentRun {
  return { id: runId, agentId: AGENT, conversationId: CONV, parentRunId: PARENT, title: 'child work', status, kind: 'background', steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT };
}
let ids = 0;
function baseCtx(): Pick<RunContext, 'rand' | 'run' | 'awakeable' | 'drainInbox'> {
  return {
    rand: { uuidv4: () => 'id' + String(ids++) },
    run: <T>(_name: string, action: () => Promise<T>): DurablePromise<T> => DurablePromise.resolve(action()),
    awakeable: <T>(): { id: string; promise: DurablePromise<T> } => ({ id: 'awake', promise: DurablePromise.resolve(new Promise<T>(() => {})) }),
    drainInbox: () => DurablePromise.resolve<WakeEvent[]>([]),
  };
}
function bodyCtx(runId: string, finished: string[], stopped: boolean): RunBodyContext {
  return {
    ...baseCtx(),
    key: runId,
    cancel: { peek: async () => stopped, get: () => (stopped ? DurablePromise.resolve(true) : DurablePromise.resolve(new Promise<boolean>(() => {}))) },
    runFinished: async (sessionKey: string, id: string) => { finished.push(sessionKey + ':' + id); },
  };
}
describe('child workflow', () => {
  it('runs a reserved child to completion in the same chat and keeps the parent pending', async () => {
    const store = createMemoryStore().forOwner?.(OWNER) ?? createMemoryStore();
    await seedParent(store);
    await store.put('items', { id: canonicalPlanId(AGENT, CONV), conversationId: CONV, at: AT, type: 'plan', runId: PARENT, agentId: AGENT, todos: [{ id: 't-root', text: 'parent work', status: 'pending' }] });
    const enqueuer = new RecordingEnqueuer();
    const prompt = 'summarize the inbox for the parent';
    const start = await reserve(store, enqueuer, prompt);
    const finished: string[] = [];
    const brain = new ScriptedTurns([sendText('child working'), final('child reply text')]);
    await runWorkflowBody(bodyCtx(start.runId, finished, false), { store, blobs: createMemoryBlobStore(), enqueuer, brain, toolRegistry: registryWith(store, enqueuer) }, subagentRunInput(start));
    const child: SubagentRun | null = await store.get('runs', start.runId);
    expect(child?.status).toBe('completed');
    expect(child?.parentRunId).toBe(PARENT);
    expect(child?.childSessionKey).toBe(start.sessionKey);
    expect(child?.planId).toBe(start.planId);
    expect(child?.kind).toBe('background');
    expect(child?.title).toBe(prompt.slice(0, 80));
    expect(child?.engine).toEqual({ id: 'pi', version: '1' });
    expect(child?.budgetSnapshot).toBeDefined();
    expect(child?.childPrompt).toBe(prompt);
    // CT: the child is silent — its result is the canonical childResult on its own row, never a bubble.
    expect(child?.childResult).toBe('child reply text');
    expect((await store.list('items', { limit: 100 })).items.some((item) => item.type === 'agent_message')).toBe(false);
    expect((await store.get('runs', PARENT))?.status).toBe('running');
    const plan = await store.get('items', canonicalPlanId(AGENT, CONV));
    expect(plan?.type === 'plan' ? plan.todos[0]?.status : 'missing').toBe('pending');
    expect(finished).toEqual([start.sessionKey + ':' + start.runId]);
  });
  it('keeps the reservation on a failed start instead of overwriting it', async () => {
    const store = createMemoryStore().forOwner?.(OWNER) ?? createMemoryStore();
    await seedParent(store);
    const enqueuer = new RecordingEnqueuer();
    const start = await reserve(store, enqueuer, 'fail me');
    const reserved: SubagentRun | null = await store.get('runs', start.runId);
    if (reserved === null) throw new Error('no reserved row');
    const budgeted: SubagentRun & { executionBudget?: unknown } = { ...reserved, executionBudget: { limits: { steps: 10 }, explicitCost: true } };
    await store.put('runs', budgeted);
    const finished: string[] = [];
    const services = { store, blobs: createMemoryBlobStore(), enqueuer, brain: new ScriptedTurns([]), toolRegistry: registryWith(store, enqueuer), engines: createEngineRegistry([]) };
    await expect(runWorkflowBody(bodyCtx(start.runId, finished, false), services, subagentRunInput(start))).rejects.toThrow();
    const child: SubagentRun | null = await store.get('runs', start.runId);
    expect(child?.status).toBe('failed');
    expect(child?.parentRunId).toBe(PARENT);
    expect(child?.childSessionKey).toBe(start.sessionKey);
    expect(child?.planId).toBe(start.planId);
    expect(child?.kind).toBe('background');
    const keptSubagent = child !== null && 'executionBudget' in child ? child.executionBudget : undefined;
    expect(keptSubagent).toEqual({ limits: { steps: 10 }, explicitCost: true });
    expect(finished).toEqual([start.sessionKey + ':' + start.runId]);
  });
  it('keeps root links, spend, and budget on a failed start', async () => {
    const store = createMemoryStore().forOwner?.(OWNER) ?? createMemoryStore();
    await seedParent(store);
    await store.put('runs', { id: 'run-root-fail', agentId: AGENT, conversationId: CONV, title: 'root', status: 'running', kind: 'chat', steps: [], usage: { inputTokens: 5, outputTokens: 3, computeSeconds: 1, costUsd: 0.01, steps: 2 }, startedAt: AT, lastActivityAt: AT, childRunIds: ['run-c-x'] });
    const seeded = await store.get('runs', 'run-root-fail');
    if (seeded === null) throw new Error('no root row');
    const rooted: SubagentRun & { executionBudget?: unknown } = { ...seeded, executionBudget: { limits: { steps: 10 }, explicitCost: false } };
    await store.put('runs', rooted);
    const released: string[] = [];
    const starter: RunStartContext = {
      runInit: async (action) => action(),
      runFail: async (action) => { await action(); },
      releaseSession: async (sessionKey, runId) => { released.push(sessionKey + ':' + runId); },
    };
    const rootInput = { agentId: AGENT, conversationId: CONV, sessionKey: PSESS, wakeEvents: [rootWake()] };
    const noPi = createEngineRegistry([]);
    await expect(startEngineForRun(starter, store, noPi, null, rootInput, 'run-root-fail', { peek: async () => false })).rejects.toThrow(/unknown engine/);
    const root = await store.get('runs', 'run-root-fail');
    expect(root?.status).toBe('failed');
    expect(root?.childRunIds).toEqual(['run-c-x']);
    const spend = root?.usage;
    expect(spend?.inputTokens).toBe(5);
    const kept = root !== null && 'executionBudget' in root ? root.executionBudget : undefined;
    expect(kept).toEqual({ limits: { steps: 10 }, explicitCost: false });
    expect(released).toEqual([PSESS + ':run-root-fail']);
  });
  it('refuses to overwrite a corrupt reservation with a root run', async () => {
    const store = createMemoryStore().forOwner?.(OWNER) ?? createMemoryStore();
    await seedParent(store);
    const enqueuer = new RecordingEnqueuer();
    const start = await reserve(store, enqueuer, 'corrupt me');
    const reserved: SubagentRun | null = await store.get('runs', start.runId);
    if (reserved === null) throw new Error('no reserved row');
    await store.put('runs', { ...reserved, parentRunId: '' });
    const released: string[] = [];
    const starter: RunStartContext = {
      runInit: async (action) => action(),
      runFail: async (action) => { await action(); },
      releaseSession: async (sessionKey, runId) => { released.push(sessionKey + ':' + runId); },
    };
    await expect(startEngineForRun(starter, store, defaultRegistry(), null, subagentRunInput(start), start.runId, { peek: async () => false })).rejects.toThrow(/invalid/);
    const kept: SubagentRun | null = await store.get('runs', start.runId);
    expect(kept?.parentRunId).toBe('');
    expect(kept?.childSessionKey).toBe(start.sessionKey);
    expect(released).toEqual([]);
  });
  it('stops the real child run when the parent stops', async () => {
    const store = createMemoryStore().forOwner?.(OWNER) ?? createMemoryStore();
    await seedParent(store);
    await store.put('runs', subagentRow('run-c-live', 'running'));
    const enqueuer = new RecordingEnqueuer();
    const finished: string[] = [];
    await runWorkflowBody(bodyCtx(PARENT, finished, true), { store, blobs: createMemoryBlobStore(), enqueuer, brain: new ScriptedTurns([final('never reached')]), toolRegistry: registryWith(store, enqueuer) }, { agentId: AGENT, conversationId: CONV, sessionKey: PSESS, wakeEvents: [rootWake()] });
    expect(enqueuer.stops).toEqual(['run-c-live']);
    expect((await store.get('runs', PARENT))?.status).toBe('stopped');
    expect(finished).toEqual([PSESS + ':' + PARENT]);
  });
  it('a live child holds the parent even when another child is done', async () => {
    const store = createMemoryStore().forOwner?.(OWNER) ?? createMemoryStore();
    await seedParent(store);
    const enqueuer = new RecordingEnqueuer();
    const done = await reserve(store, enqueuer, 'done work');
    const doneRow: SubagentRun | null = await store.get('runs', done.runId);
    if (doneRow === null) throw new Error('no reserved row');
    await store.put('runs', { ...doneRow, status: 'completed' });
    await store.put('runs', subagentRow('run-c-extra', 'running'));
    const finished: string[] = [];
    const brain = new ScriptedTurns([final('parent got results')]);
    const input = { agentId: AGENT, conversationId: CONV, sessionKey: PSESS, wakeEvents: [rootWake()] };
    await runWorkflowBody(bodyCtx(PARENT, finished, false), { store, blobs: createMemoryBlobStore(), enqueuer, brain, toolRegistry: registryWith(store, enqueuer) }, input);
    const reply = (await store.list('items', { limit: 100 })).items.find((item) => item.type === 'agent_message' && item.markdown === 'parent got results');
    if (reply?.type !== 'agent_message') throw new Error('no parent reply');
    expect(reply.runId).toBe(PARENT);
    expect(reply.conversationId).toBe(CONV);
    // CT-boundary: the parent cannot complete while run-c-extra is still live; the blocked
    // outcome is truthful and names the live child instead of a silent completion.
    const parent = await store.get('runs', PARENT);
    expect(parent?.status).toBe('blocked');
    expect(parent?.error ?? '').toMatch(/1 subagent\(s\) still active/);
    expect(parent?.error ?? '').not.toContain('run-c-extra');
    expect((await store.get('runs', 'run-c-extra'))?.status).toBe('running');
    expect(finished).toEqual([PSESS + ':' + PARENT]);
  });
});

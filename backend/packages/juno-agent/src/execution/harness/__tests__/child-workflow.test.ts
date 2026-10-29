/** PH12 child workflow: reserved children run end to end, wait observably, steer, and stop really. */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore } from '../../../testing/store.js';
import type { AssistantTurn, Brain, BrainContext, ChildRunStart, Enqueuer, Store, ToolRegistry, WakeEvent } from '../../../contracts/index.js';
import { childRunInput } from '../../child-run-input.js';
import { createSendMessageTool } from '../../../modules/tools/tools/sendMessage.js';
import { createChildWaitTool } from '../../../modules/tasks/childTools.js';
import { spawnChildTask, type ChildRun } from '../../../modules/tasks/child.js';
import { canonicalPlanId } from '../../../modules/tasks/state.js';
import { createEngineRegistry } from '../engines/registry.js';
import { handleSuspension } from '../engines/pi-core/suspend.js';
import { CANCELLED, NEVER_CANCELLED, type RunCancellation } from '../services/cancel.js';
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
function sendText(text: string): AssistantTurn { return { text: '', toolCalls: [{ id: 's1', name: 'send_message', arguments: { kind: 'text', text } }], usage, stopReason: 'tool_calls' }; }
function final(text: string): AssistantTurn { return { text, toolCalls: [], usage, stopReason: 'stop' }; }
class RecordingEnqueuer implements Enqueuer {
  stops: string[] = [];
  starts: ChildRunStart[] = [];
  async enqueue(): Promise<{ accepted: boolean }> { return { accepted: true }; }
  async stopRun(runId: string): Promise<void> { this.stops.push(runId); }
  async resolveAwakeable(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
  async startChildRun(input: ChildRunStart): Promise<void> { this.starts.push(input); }
}
function registryWith(store: Store, enqueuer: Enqueuer): ToolRegistry {
  const tools = [createSendMessageTool({ store, enqueuer }), createChildWaitTool()];
  return { forAgent: async () => tools, get: (name) => tools.find((tool) => tool.name === name) };
}
function rootWake(): WakeEvent { return { id: 'wake-parent', ownerId: OWNER, agentId: AGENT, sessionKey: PSESS, conversationId: CONV, kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: 'go' }, at: AT, status: 'accepted' }; }
async function seedParent(store: Store): Promise<void> {
  await store.put('agents', { id: AGENT, name: AGENT, handle: AGENT, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 't', status: 'idle', section: 'Work', pinned: false, lastActivity: '', unreadCount: 0, model: { planner: { provider: 'scripted', model: 't' }, computer: { provider: 'scripted', model: 't' }, fast: { provider: 'scripted', model: 't' } }, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdAt: AT, updatedAt: AT });
  await store.put('conversations', { id: CONV, kind: 'direct', agentIds: [AGENT], memberIds: [], unreadCount: 0, lastItemAt: AT, createdAt: AT });
  await store.put('runs', { id: PARENT, agentId: AGENT, conversationId: CONV, title: 'parent', status: 'running', kind: 'chat', steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT, childRunIds: [] });
}
async function reserve(store: Store, enqueuer: RecordingEnqueuer, prompt: string): Promise<ChildRunStart> {
  const spawned = await spawnChildTask(store, { ownerId: OWNER, agentId: AGENT, parentRunId: PARENT, conversationId: CONV, callId: 'stp-1', prompt, targetAgentId: AGENT }, { startChildRun: async (input) => { enqueuer.starts.push(input); } });
  if (!spawned.ok) throw new Error('reserve failed: ' + spawned.reason);
  const started = enqueuer.starts[enqueuer.starts.length - 1];
  if (started === undefined) throw new Error('no start recorded');
  return started;
}
function childRow(runId: string, status: 'running' | 'completed'): ChildRun {
  return { id: runId, agentId: AGENT, conversationId: CONV, parentRunId: PARENT, title: 'child work', status, kind: 'background', steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT };
}
let ids = 0;
function baseCtx(): Pick<RunContext, 'rand' | 'run' | 'awakeable' | 'drainInbox'> {
  return {
    rand: { uuidv4: () => 'id' + String(ids++) },
    run: <T>(_name: string, action: () => Promise<T>): RestatePromise<T> => RestatePromise.resolve(action()),
    awakeable: <T>(): { id: string; promise: RestatePromise<T> } => ({ id: 'awake', promise: RestatePromise.resolve(new Promise<T>(() => {})) }),
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
  };
}
function bodyCtx(runId: string, finished: string[], stopped: boolean): RunBodyContext {
  return {
    ...baseCtx(),
    key: runId,
    cancel: { peek: async () => stopped, get: () => (stopped ? RestatePromise.resolve(true) : RestatePromise.resolve(new Promise<boolean>(() => {}))) },
    runFinished: async (sessionKey: string, id: string) => { finished.push(sessionKey + ':' + id); },
  };
}
function waitCtx(drains: WakeEvent[][] = [], start = 1000, slept: { count: number } = { count: 0 }): RunContext {
  const now = { value: start };
  return {
    ...baseCtx(),
    sleep: (ms: number) => { slept.count += 1; now.value += ms; return RestatePromise.resolve(undefined); },
    date: { now: () => RestatePromise.resolve(now.value) },
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>(drains.shift() ?? []),
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
    await runWorkflowBody(bodyCtx(start.runId, finished, false), { store, blobs: createMemoryBlobStore(), enqueuer, brain, toolRegistry: registryWith(store, enqueuer) }, childRunInput(start));
    const child: ChildRun | null = await store.get('runs', start.runId);
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
    const reserved: ChildRun | null = await store.get('runs', start.runId);
    if (reserved === null) throw new Error('no reserved row');
    const budgeted: ChildRun & { executionBudget?: unknown } = { ...reserved, executionBudget: { limits: { steps: 10 }, explicitCost: true } };
    await store.put('runs', budgeted);
    const finished: string[] = [];
    const services = { store, blobs: createMemoryBlobStore(), enqueuer, brain: new ScriptedTurns([]), toolRegistry: registryWith(store, enqueuer), engines: createEngineRegistry([]) };
    await expect(runWorkflowBody(bodyCtx(start.runId, finished, false), services, childRunInput(start))).rejects.toThrow();
    const child: ChildRun | null = await store.get('runs', start.runId);
    expect(child?.status).toBe('failed');
    expect(child?.parentRunId).toBe(PARENT);
    expect(child?.childSessionKey).toBe(start.sessionKey);
    expect(child?.planId).toBe(start.planId);
    expect(child?.kind).toBe('background');
    const keptChild = child !== null && 'executionBudget' in child ? child.executionBudget : undefined;
    expect(keptChild).toEqual({ limits: { steps: 10 }, explicitCost: true });
    expect(finished).toEqual([start.sessionKey + ':' + start.runId]);
  });
  it('keeps root links, spend, and budget on a failed start', async () => {
    const store = createMemoryStore().forOwner?.(OWNER) ?? createMemoryStore();
    await seedParent(store);
    await store.put('runs', { id: 'run-root-fail', agentId: AGENT, conversationId: CONV, title: 'root', status: 'running', kind: 'chat', steps: [], usage: { inputTokens: 5, outputTokens: 3, computeSeconds: 1, costUsd: 0.01, steps: 2 }, startedAt: AT, lastActivityAt: AT, childRunIds: ['run-c-x'] });
    const seeded = await store.get('runs', 'run-root-fail');
    if (seeded === null) throw new Error('no root row');
    const rooted: ChildRun & { executionBudget?: unknown } = { ...seeded, executionBudget: { limits: { steps: 10 }, explicitCost: false } };
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
    const reserved: ChildRun | null = await store.get('runs', start.runId);
    if (reserved === null) throw new Error('no reserved row');
    await store.put('runs', { ...reserved, parentRunId: '' });
    const released: string[] = [];
    const starter: RunStartContext = {
      runInit: async (action) => action(),
      runFail: async (action) => { await action(); },
      releaseSession: async (sessionKey, runId) => { released.push(sessionKey + ':' + runId); },
    };
    await expect(startEngineForRun(starter, store, defaultRegistry(), null, childRunInput(start), start.runId, { peek: async () => false })).rejects.toThrow(/invalid/);
    const kept: ChildRun | null = await store.get('runs', start.runId);
    expect(kept?.parentRunId).toBe('');
    expect(kept?.childSessionKey).toBe(start.sessionKey);
    expect(released).toEqual([]);
  });
  it('waits the selected children, steers promptly, times out honestly, and lets a stop win', async () => {
    const store = createMemoryStore().forOwner?.(OWNER) ?? createMemoryStore();
    await seedParent(store);
    await store.put('runs', childRow('run-c-done', 'completed'));
    await store.put('runs', childRow('run-c-pending', 'running'));
    // CT: the parent-visible result is the canonical childResult on the child's own row.
    await store.patch('runs', 'run-c-done', { childResult: 'done result here' });
    const services = { store, blobs: createMemoryBlobStore(), enqueuer: new RecordingEnqueuer(), brain: new ScriptedTurns([]), toolRegistry: { forAgent: async () => [], get: () => undefined } };
    const selected = await handleSuspension({ ctx: waitCtx(), services, input: { agentId: AGENT, conversationId: CONV, sessionKey: PSESS, wakeEvents: [rootWake()] }, runId: PARENT, stepIndex: 0, suspend: { reason: 'child' }, details: { waiting: ['run-c-done'] }, cancellation: NEVER_CANCELLED });
    expect(selected).toBe('resume');
    const first = (await store.list('transcripts', { limit: 50 })).items.filter((entry) => entry.sessionKey === PSESS);
    expect(JSON.stringify(first[0]?.message)).toContain('done result here');
    const timed = await handleSuspension({ ctx: waitCtx(), services, input: { agentId: AGENT, conversationId: CONV, sessionKey: PSESS, wakeEvents: [rootWake()] }, runId: PARENT, stepIndex: 1, suspend: { reason: 'child', until: new Date(500).toISOString() }, details: { waiting: ['run-c-pending'] }, cancellation: NEVER_CANCELLED });
    expect(timed).toBe('resume');
    const explicit = await handleSuspension({ ctx: waitCtx(), services, input: { agentId: AGENT, conversationId: CONV, sessionKey: PSESS, wakeEvents: [rootWake()] }, runId: PARENT, stepIndex: 4, suspend: { reason: 'child' }, details: { runIds: ['run-c-done'], waiting: ['run-c-pending'] }, cancellation: NEVER_CANCELLED });
    expect(explicit).toBe('resume');
    await expect(handleSuspension({ ctx: waitCtx(), services, input: { agentId: AGENT, conversationId: CONV, sessionKey: PSESS, wakeEvents: [rootWake()] }, runId: PARENT, stepIndex: 5, suspend: { reason: 'child' }, details: { waiting: ['run-c-done', 7] }, cancellation: NEVER_CANCELLED })).rejects.toThrow(/malformed/);
    await expect(handleSuspension({ ctx: waitCtx(), services, input: { agentId: AGENT, conversationId: CONV, sessionKey: PSESS, wakeEvents: [rootWake()] }, runId: PARENT, stepIndex: 6, suspend: { reason: 'child', until: 'not-a-date' }, cancellation: NEVER_CANCELLED })).rejects.toThrow(/malformed/);
    const explicitNotes = (await store.list('transcripts', { limit: 50 })).items.filter((entry) => entry.sessionKey === PSESS);
    expect(explicitNotes.length).toBe(3);
    const explicitTexts = explicitNotes.map((entry) => JSON.stringify(entry.message));
    expect(explicitTexts.filter((text) => text !== undefined && text.includes('run-c-done')).length).toBe(2);
    expect(explicitTexts.filter((text) => text !== undefined && text.includes('run-c-pending')).length).toBe(1);
    const stopper: RunCancellation = { ...NEVER_CANCELLED, race: async <T>(): Promise<T | typeof CANCELLED> => CANCELLED };
    const stopped = await handleSuspension({ ctx: waitCtx(), services, input: { agentId: AGENT, conversationId: CONV, sessionKey: PSESS, wakeEvents: [rootWake()] }, runId: PARENT, stepIndex: 2, suspend: { reason: 'child' }, cancellation: stopper });
    expect(stopped).toBe('stopped');
    expect((await store.list('transcripts', { limit: 50 })).items.filter((entry) => entry.sessionKey === PSESS).length).toBe(3);
    const steered = await handleSuspension({ ctx: waitCtx([[rootWake()]]), services: { store, blobs: createMemoryBlobStore(), enqueuer: new RecordingEnqueuer(), brain: new ScriptedTurns([]), toolRegistry: { forAgent: async () => [], get: () => undefined } }, input: { agentId: AGENT, conversationId: CONV, sessionKey: PSESS, wakeEvents: [rootWake()] }, runId: PARENT, stepIndex: 3, suspend: { reason: 'child' }, cancellation: NEVER_CANCELLED });
    expect(steered).toBe('resume');
    const entries = (await store.list('transcripts', { limit: 50 })).items.filter((entry) => entry.sessionKey === PSESS);
    expect(entries.length).toBe(5);
    expect(JSON.stringify(entries.map((entry) => entry.message))).toContain('steered');
    expect((await store.get('runs', 'run-c-pending'))?.status).toBe('running');
    const slept = { count: 0 };
    const both = await handleSuspension({ ctx: waitCtx([], 1000, slept), services, input: { agentId: AGENT, conversationId: CONV, sessionKey: PSESS, wakeEvents: [rootWake()] }, runId: PARENT, stepIndex: 7, suspend: { reason: 'child' }, details: { waiting: ['run-c-pending'], timeoutMs: 60000, until: new Date(500).toISOString() }, cancellation: NEVER_CANCELLED });
    expect(both).toBe('resume');
    expect(slept.count).toBe(0);
    const none = await handleSuspension({ ctx: waitCtx(), services, input: { agentId: AGENT, conversationId: CONV, sessionKey: PSESS, wakeEvents: [rootWake()] }, runId: PARENT, stepIndex: 8, suspend: { reason: 'child' }, details: { runIds: [] }, cancellation: NEVER_CANCELLED });
    expect(none).toBe('resume');
    const last = (await store.list('transcripts', { limit: 50 })).items.filter((entry) => entry.sessionKey === PSESS);
    const lastTexts = last.map((entry) => JSON.stringify(entry.message));
    expect(lastTexts.some((text) => text !== undefined && text.includes('no child tasks observed'))).toBe(true);
  });
  it('stops the real child run when the parent stops', async () => {
    const store = createMemoryStore().forOwner?.(OWNER) ?? createMemoryStore();
    await seedParent(store);
    await store.put('runs', childRow('run-c-live', 'running'));
    const enqueuer = new RecordingEnqueuer();
    const finished: string[] = [];
    await runWorkflowBody(bodyCtx(PARENT, finished, true), { store, blobs: createMemoryBlobStore(), enqueuer, brain: new ScriptedTurns([final('never reached')]), toolRegistry: registryWith(store, enqueuer) }, { agentId: AGENT, conversationId: CONV, sessionKey: PSESS, wakeEvents: [rootWake()] });
    expect(enqueuer.stops).toEqual(['run-c-live']);
    expect((await store.get('runs', PARENT))?.status).toBe('stopped');
    expect(finished).toEqual([PSESS + ':' + PARENT]);
  });
  it('selects a done child through the real tool while another live child holds the parent', async () => {
    const store = createMemoryStore().forOwner?.(OWNER) ?? createMemoryStore();
    await seedParent(store);
    const enqueuer = new RecordingEnqueuer();
    const done = await reserve(store, enqueuer, 'done work');
    const doneRow: ChildRun | null = await store.get('runs', done.runId);
    if (doneRow === null) throw new Error('no reserved row');
    await store.put('runs', { ...doneRow, status: 'completed' });
    // CT: the done child's result is the canonical childResult on its row.
    await store.patch('runs', done.runId, { childResult: 'done work output' });
    await store.put('runs', childRow('run-c-extra', 'running'));
    const finished: string[] = [];
    const waitCall: AssistantTurn = { text: '', toolCalls: [{ id: 'w1', name: 'child_wait', arguments: { runIds: [done.runId] } }], usage, stopReason: 'tool_calls' };
    const brain = new ScriptedTurns([waitCall, final('parent got results')]);
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
    expect(parent?.error ?? '').toMatch(/child task\(s\) still active/);
    expect(parent?.error ?? '').toContain('run-c-extra');
    expect((await store.get('runs', 'run-c-extra'))?.status).toBe('running');
    const said = (await store.list('transcripts', { limit: 100 })).items.filter((entry) => entry.sessionKey === PSESS);
    expect(JSON.stringify(said.map((entry) => entry.message))).toContain('done work output');
    expect(finished).toEqual([PSESS + ':' + PARENT]);
  });
});

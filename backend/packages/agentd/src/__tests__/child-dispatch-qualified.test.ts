/**
 * PH12-dispatch qualification: the actual admitted child target, idempotent delivery and result
 * attribution through the PRODUCTION composition (never helper-only counts).
 *
 * Every admission assertion names the exact owner (never a vacuous toBeDefined): the canonical
 * child session passes only for its reserved run, parent, owner, agent and room membership. The
 * dispatcher starts the exact reserved run id on its canonical session/plan; a failed delivery stays
 * pending and is redelivered on the SAME workflow key — via same-step replay AND via an explicit
 * retryRunId from a later step (a new step id would otherwise orphan the pending row). The row stores
 * the immutable prompt and a parent-frozen budget remainder produced by the real producer
 * (snapshotOf) and frozen by the real consumer (inheritBudgetSnapshot): changed settings never move
 * it, spent or unknown budgets refuse, and corrupt snapshots fail closed. Results attribute the exact
 * child run id + agent across pages (never the latest message from anyone); over-cap scans throw
 * instead of reporting partial results. child_wait refuses foreign ids truthfully and carries
 * validated runIds + deadline in private details for the core. Cancel delivery failures throw and
 * expire nothing; success expires pending requests with request.resolved events while preserving
 * approved ones. Delivery-state writes are narrow patches that never clobber a started child, and a
 * failed write reports retryable instead of a false ok.
 */
import { createMemoryBlobStore } from '@agent-desktop/db';
import { describe, it, expect } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { ChildRunStart, Enqueuer, Store, ToolContext, WakeEvent } from '@agent-desktop/contracts';
import type { Agent, AppSettings, Conversation, Item, Request } from '@agent-desktop/public-contracts';
import { childRunInput, RunnerEnqueuer } from '../enqueuer.js';
import { RunnerStub } from './runner-stub.js';
import { createExecutionTools } from 'juno-agent/execution/mcp-runtime';
import { resolveAdmittedOwner } from 'juno-agent/execution/execution-owner';
import { createChildDispatchAdapter } from 'juno-agent/execution/child-dispatch';
import { childPlanId, childRunId, childSessionKey, listChildTasks, type ChildRun } from 'juno-agent/modules/tasks/child';
import { markDispatch } from 'juno-agent/modules/tasks/childRetry';
import { createRunBudget, snapshotOf } from 'juno-agent/execution/harness/services/run-budget';

const OWNER = 'owner-1';
const FOREIGN = 'owner-9';
const AGENT = 'agent-a';
const TARGET = 'agent-b';
const CONV = 'conv-parent';
const PARENT = 'run-parent';
const STEP = 'stp-1';
const AT = '2026-10-08T00:00:00.000Z';

class RecordingEnqueuer implements Enqueuer {
  readonly starts: ChildRunStart[] = [];
  async enqueue(): Promise<{ accepted: boolean }> { return { accepted: true }; }
  async stopRun(): Promise<void> {}
  async resolveAwakeable(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
  async startChildRun(input: ChildRunStart): Promise<void> { this.starts.push(input); }
}

class FlakyEnqueuer implements Enqueuer {
  readonly starts: ChildRunStart[] = [];
  failNext = true;
  async enqueue(): Promise<{ accepted: boolean }> { return { accepted: true }; }
  async stopRun(): Promise<void> {}
  async resolveAwakeable(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
  async startChildRun(input: ChildRunStart): Promise<void> {
    this.starts.push(input);
    if (this.failNext) {
      this.failNext = false;
      throw new Error('restate ingress unavailable');
    }
  }
}

const wake: WakeEvent = {
  id: 'w', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV,
  kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, at: AT, status: 'accepted',
};

function ctxFor(store: Store, stepId = STEP, agentId = AGENT): ToolContext {
  return { ownerId: OWNER, agentId, conversationId: CONV, runId: PARENT, stepId, store, blobs: createMemoryBlobStore(), enqueuer: { enqueue: async () => ({ accepted: true }), stopRun: async () => undefined, resolveAwakeable: async () => undefined, scheduleRoutine: async () => undefined }, wake, step: async (_name, fn) => fn(), signal: new AbortController().signal };
}

function agentDoc(id: string, owner: string): Agent {
  return { id, name: id, handle: id, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 't', status: 'idle', section: 'Work', pinned: false, lastActivity: '', unreadCount: 0, model: { planner: { provider: 'scripted', model: 't' }, computer: { provider: 'scripted', model: 't' }, fast: { provider: 'scripted', model: 't' } }, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdBy: owner, createdAt: AT, updatedAt: AT };
}

function parentDoc(): ChildRun {
  return {
    id: PARENT, agentId: AGENT, conversationId: CONV, title: 'parent', status: 'running', kind: 'chat', steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
  };
}

function conversationDoc(): Conversation {
  return { id: CONV, kind: 'direct', title: 'p', agentIds: [AGENT, TARGET], memberIds: [OWNER], unreadCount: 0, lastItemAt: AT, createdAt: AT };
}

async function seed(store: Store): Promise<Store> {
  const scoped = store.forOwner === undefined ? store : store.forOwner(OWNER);
  await scoped.put('agents', agentDoc(AGENT, OWNER));
  await scoped.put('agents', agentDoc(TARGET, OWNER));
  await scoped.put('runs', parentDoc(), { agentId: AGENT, conversationId: CONV });
  await scoped.put('conversations', conversationDoc(), { conversationId: CONV });
  return scoped;
}

function messageDoc(id: string, agentId: string, markdown: string, runId?: string): Item {
  const base = { id, conversationId: CONV, type: 'agent_message' as const, agentId, markdown, citations: [], at: AT };
  return runId === undefined ? base : { ...base, runId };
}

function settingsDoc(steps: number, tokens: number): AppSettings {
  return {
    general: { launchAtLogin: false, language: 'en' },
    appearance: { theme: 'system', density: 'comfortable', accent: 'blue' },
    notifications: [],
    usage: { steps, tokens },
    yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: 'not_requested' },
    connections: { serverUrl: 'http://localhost', modelProviders: [] },
    privacy: { dataRetentionDays: 30, trainingOptIn: false },
    advanced: { releaseTrack: 'stable', logsEnabled: false, networkDebugger: false },
  };
}

function approvalDoc(): Request {
  return {
    id: 'req-1', kind: 'approval', status: 'pending', title: 'approve', summary: 'needs a human',
    agentId: AGENT, conversationId: CONV, runId: PARENT,
    payload: { kind: 'approval', action: 'send', why: 'test' }, createdAt: AT,
  };
}

describe('qualified child dispatch', () => {
  it('admits the canonical child session for its exact owner, parent, agent and room', async () => {
    const store = createMemoryStore();
    const scoped = await seed(store);
    const enqueuer = new RecordingEnqueuer();
    const tools = await createExecutionTools({ store: scoped, enqueuer });
    const spawned = await tools.get('child_spawn')?.execute({ prompt: 'do the thing', targetAgentId: TARGET }, ctxFor(scoped));
    expect(spawned?.isError).not.toBe(true);
    const reserved = childRunId({ ownerId: OWNER, parentRunId: PARENT, callId: STEP });
    const start = enqueuer.starts[0];
    if (start === undefined) throw new Error('no child start recorded');
    expect(start.runId).toBe(reserved);
    expect(start.agentId).toBe(TARGET);
    expect(start.sessionKey).toBe(childSessionKey(TARGET, CONV, reserved));
    expect(start.planId).toBe(childPlanId(TARGET, CONV, reserved));
    const row: ChildRun | null = await store.get('runs', reserved);
    if (row === null) throw new Error('reserved child row missing');
    expect(row.agentId).toBe(TARGET);
    expect(row.childSessionKey).toBe(start.sessionKey);
    expect(row.planId).toBe(start.planId);
    expect(row.parentRunId).toBe(PARENT);
    const body = childRunInput(start);
    const wake0 = body.wakeEvents[0];
    if (wake0 === undefined) throw new Error('no child wake recorded');
    await expect(resolveAdmittedOwner(store, body.wakeEvents, { agentId: TARGET, conversationId: CONV, sessionKey: start.sessionKey })).resolves.toEqual({ ownerId: OWNER });
    const forgedRootWake = { ...wake0, sessionKey: TARGET + ':' + CONV };
    await expect(resolveAdmittedOwner(store, [forgedRootWake], { agentId: TARGET, conversationId: CONV, sessionKey: TARGET + ':' + CONV })).resolves.toEqual({ reason: 'wake_target_mismatch' });
    const forgedKey = childSessionKey(TARGET, CONV, 'run_child_forged000');
    await expect(resolveAdmittedOwner(store, [{ ...wake0, sessionKey: forgedKey }], { agentId: TARGET, conversationId: CONV, sessionKey: forgedKey })).resolves.toEqual({ reason: 'unknown_child_run' });
    const foreignWake = { ...wake0, ownerId: FOREIGN };
    await expect(resolveAdmittedOwner(store, [foreignWake], { agentId: TARGET, conversationId: CONV, sessionKey: start.sessionKey })).resolves.toEqual({ reason: 'agent_owner_mismatch' });
    const tampered = { ...wake0, payload: { ...wake0.payload, childRunId: 'run_child_forged' } };
    await expect(resolveAdmittedOwner(store, [tampered], { agentId: TARGET, conversationId: CONV, sessionKey: start.sessionKey })).resolves.toEqual({ reason: 'wake_target_mismatch' });
  });

  it('refuses a target outside the room and a mismatched parent conversation', async () => {
    const store = createMemoryStore();
    const scoped = await seed(store);
    await scoped.put('agents', agentDoc('agent-outsider', OWNER));
    const tools = await createExecutionTools({ store: scoped, enqueuer: new RecordingEnqueuer() });
    expect((await tools.get('child_spawn')?.execute({ prompt: 'x', targetAgentId: 'agent-outsider' }, ctxFor(scoped)))?.details).toMatchObject({ refused: 'target_not_authorized' });
    expect((await tools.get('child_spawn')?.execute({ prompt: 'x' }, { ...ctxFor(scoped), conversationId: 'conv-other' }))?.details).toMatchObject({ refused: 'parent_conversation_mismatch' });
  });

  it('starts only the reserved row on its canonical session, plan and owner', async () => {
    const store = createMemoryStore();
    const scoped = await seed(store);
    const enqueuer = new RecordingEnqueuer();
    const adapter = createChildDispatchAdapter({ store: scoped, enqueuer });
    const reserved = childRunId({ ownerId: OWNER, parentRunId: PARENT, callId: STEP });
    const sessionKey = childSessionKey(TARGET, CONV, reserved);
    const start: ChildRunStart = { runId: reserved, ownerId: OWNER, agentId: TARGET, conversationId: CONV, sessionKey, planId: childPlanId(TARGET, CONV, reserved), parentRunId: PARENT, prompt: 'work', depth: 1 };
    await expect(adapter.startChildRun(start)).rejects.toThrow(/not reserved/);
    const tools = await createExecutionTools({ store: scoped, enqueuer });
    expect((await tools.get('child_spawn')?.execute({ prompt: 'work', targetAgentId: TARGET }, ctxFor(scoped)))?.isError).not.toBe(true);
    expect(enqueuer.starts.map((entry) => entry.runId)).toEqual([reserved]);
    await expect(adapter.startChildRun({ ...start, sessionKey: 'other' })).rejects.toThrow(/canonical/);
    await expect(adapter.startChildRun({ ...start, planId: 'plan-forged' })).rejects.toThrow(/plan/);
    await expect(adapter.startChildRun({ ...start, ownerId: FOREIGN })).rejects.toThrow(/owner/);
  });

  it('retries a failed delivery on the same key via replay and via later-step retryRunId', async () => {
    const store = createMemoryStore();
    const scoped = await seed(store);
    const enqueuer = new FlakyEnqueuer();
    const tools = await createExecutionTools({ store: scoped, enqueuer });
    const first = await tools.get('child_spawn')?.execute({ prompt: 'important work', targetAgentId: TARGET }, ctxFor(scoped, STEP));
    expect(first?.isError).toBe(true);
    expect(first?.details).toMatchObject({ refused: 'dispatch_failed' });
    const runId = first?.details?.['runId'];
    expect(typeof runId).toBe('string');
    const reserved = childRunId({ ownerId: OWNER, parentRunId: PARENT, callId: STEP });
    expect(runId).toBe(reserved);
    const pending: ChildRun | null = await scoped.get('runs', reserved);
    expect(pending?.dispatch).toBe('pending');
    const retry = await tools.get('child_spawn')?.execute({ prompt: 'important work', targetAgentId: TARGET, retryRunId: String(runId) }, ctxFor(scoped, 'stp-2'));
    expect(retry?.isError).not.toBe(true);
    expect(enqueuer.starts.map((entry) => entry.runId)).toEqual([reserved, reserved]);
    expect(await listChildTasks(scoped, PARENT)).toHaveLength(1);
    const parent: ChildRun | null = await scoped.get('runs', PARENT);
    expect(parent?.childRunIds).toEqual([reserved]);
    const foreign = await tools.get('child_spawn')?.execute({ prompt: 'x', retryRunId: 'run_child_nope' }, ctxFor(scoped, 'stp-3'));
    expect(foreign?.isError).toBe(true);
  });

  it('rejects retry on a pre-aborted signal and on terminal rows', async () => {
    const store = createMemoryStore();
    const scoped = await seed(store);
    const enqueuer = new FlakyEnqueuer();
    const tools = await createExecutionTools({ store: scoped, enqueuer });
    const first = await tools.get('child_spawn')?.execute({ prompt: 'work', targetAgentId: TARGET }, ctxFor(scoped, STEP));
    const runId = first?.details?.['runId'];
    if (typeof runId !== 'string') throw new Error('retry id missing');
    const aborted = { ...ctxFor(scoped, 'stp-aborted'), signal: AbortSignal.abort() };
    const refused = await tools.get('child_spawn')?.execute({ prompt: 'work', targetAgentId: TARGET, retryRunId: runId }, aborted);
    expect(refused?.isError).toBe(true);
    expect(enqueuer.starts).toHaveLength(1);
    await scoped.patch('runs', PARENT, { status: 'stopped', finishedAt: AT });
    const afterStop = await tools.get('child_spawn')?.execute({ prompt: 'work', targetAgentId: TARGET, retryRunId: runId }, ctxFor(scoped, 'stp-late'));
    expect(afterStop?.details).toMatchObject({ refused: 'parent_terminal' });
    expect(enqueuer.starts).toHaveLength(1);
    await scoped.patch('runs', PARENT, { status: 'running' });
    await scoped.patch('runs', runId, { status: 'stopped' });
    const deadRow = await tools.get('child_spawn')?.execute({ prompt: 'work', targetAgentId: TARGET, retryRunId: runId }, ctxFor(scoped, 'stp-dead'));
    expect(deadRow?.details).toMatchObject({ refused: 'parent_terminal' });
    expect(enqueuer.starts).toHaveLength(1);
  });

  it('inherits the real remaining budget: producer usage, consumer snapshot and expiry', async () => {
    const store = createMemoryStore();
    const scoped = await seed(store);
    const parentBudget = createRunBudget({ steps: 10, tokens: 1000, activeSeconds: 60, costUsd: 1, onUnknown: 'block' }, true);
    parentBudget.charge('model:0', { inputTokens: 300, outputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 25, costUsd: 0.2, costKnown: true, measured: true }, 5_000);
    parentBudget.charge('tool:0:c1', { inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: true, measured: true }, 2_000);
    const snapshot = snapshotOf(parentBudget);
    const totals = parentBudget.totals();
    const seeded: ChildRun | null = await scoped.get('runs', PARENT);
    if (seeded === null) throw new Error('parent row missing');
    const budgeted: ChildRun = { ...seeded, usage: { ...seeded.usage, steps: totals.steps, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, cacheReadTokens: totals.cacheReadTokens, cacheWriteTokens: totals.cacheWriteTokens, computeSeconds: totals.activeMs / 1000, costUsd: totals.costUsd, costKnown: true, measured: true }, executionBudget: snapshot };
    await scoped.put('runs', budgeted, { agentId: AGENT, conversationId: CONV });
    const enqueuer = new RecordingEnqueuer();
    const tools = await createExecutionTools({ store: scoped, enqueuer });
    const spawned = await tools.get('child_spawn')?.execute({ prompt: 'budgeted work', targetAgentId: TARGET }, ctxFor(scoped, STEP));
    expect(spawned?.isError).not.toBe(true);
    const reserved = childRunId({ ownerId: OWNER, parentRunId: PARENT, callId: STEP });
    const row: ChildRun | null = await scoped.get('runs', reserved);
    if (row === null || row.budgetSnapshot === undefined) throw new Error('child snapshot missing');
    expect(row.budgetSnapshot.explicitCost).toBe(true);
    expect(row.budgetSnapshot.parentTokens).toBe(300 + 100 + 50 + 25);
    expect(row.budgetSnapshot.parentMeasured).toBe(true);
    expect(row.budgetSnapshot.parentCostKnown).toBe(true);
    expect(row.budgetSnapshot.limits.tokens).toBe(1000 - (300 + 100 + 50 + 25));
    expect(row.budgetSnapshot.limits.steps).toBe(10 - 2);
    expect(row.budgetSnapshot.limits.activeSeconds).toBe(60 - 7);
    expect(row.budgetSnapshot.limits.costUsd).toBeCloseTo(1 - 0.2, 5);
    await scoped.put('settings', { ...settingsDoc(9999, 999999), id: 'app-settings-' + OWNER });
    const fresh = await tools.get('child_spawn')?.execute({ prompt: 'fresh', targetAgentId: TARGET }, ctxFor(scoped, 'stp-fresh'));
    expect(fresh?.details).toMatchObject({ spawned: { parentRunId: PARENT } });
    const freshRow: ChildRun | null = await scoped.get('runs', childRunId({ ownerId: OWNER, parentRunId: PARENT, callId: 'stp-fresh' }));
    expect(freshRow?.budgetSnapshot?.limits.steps).toBe(row.budgetSnapshot.limits.steps);
    const spent: ChildRun | null = await scoped.get('runs', PARENT);
    if (spent === null) throw new Error('parent row missing');
    await scoped.put('runs', { ...spent, usage: { ...spent.usage, steps: 10, inputTokens: 900, outputTokens: 50, cacheReadTokens: 25, cacheWriteTokens: 25, computeSeconds: 60, costUsd: 1, costKnown: true, measured: true } }, { agentId: AGENT, conversationId: CONV });
    const blocked = await tools.get('child_spawn')?.execute({ prompt: 'blocked', targetAgentId: TARGET }, ctxFor(scoped, 'stp-blocked'));
    expect(blocked?.details).toMatchObject({ refused: 'budget_exhausted' });
  });

  it('refuses unknown spend under an explicit budget and corrupt snapshots fail closed', async () => {
    const store = createMemoryStore();
    const scoped = await seed(store);
    const enqueuer = new RecordingEnqueuer();
    const tools = await createExecutionTools({ store: scoped, enqueuer });
    const seeded: ChildRun | null = await scoped.get('runs', PARENT);
    if (seeded === null) throw new Error('parent row missing');
    const unpriced: ChildRun = { ...seeded, usage: { ...seeded.usage, costUsd: 0, costKnown: false, measured: true }, executionBudget: { limits: { costUsd: 1 }, explicitCost: true } };
    await scoped.put('runs', unpriced, { agentId: AGENT, conversationId: CONV });
    const unknown = await tools.get('child_spawn')?.execute({ prompt: 'priced-unknown', targetAgentId: TARGET }, ctxFor(scoped, 'stp-u1'));
    expect(unknown?.details).toMatchObject({ refused: 'budget_exhausted' });
    expect(enqueuer.starts).toHaveLength(0);
    const malformed: ChildRun = { ...seeded, usage: { ...seeded.usage }, executionBudget: { limits: { steps: Number.NaN }, explicitCost: true } };
    await scoped.put('runs', malformed, { agentId: AGENT, conversationId: CONV });
    const corruptSpawn = await tools.get('child_spawn')?.execute({ prompt: 'corrupt', targetAgentId: TARGET }, ctxFor(scoped, 'stp-u2'));
    expect(corruptSpawn?.details).toMatchObject({ refused: 'budget_exhausted' });
    expect(enqueuer.starts).toHaveLength(0);
    const legacyParent: ChildRun = { ...seeded, usage: { ...seeded.usage } };
    await scoped.put('runs', legacyParent, { agentId: AGENT, conversationId: CONV });
    const legacy = await tools.get('child_spawn')?.execute({ prompt: 'legacy', targetAgentId: TARGET }, ctxFor(scoped, 'stp-u3'));
    expect(legacy?.isError).not.toBe(true);
    expect(enqueuer.starts).toHaveLength(1);
  });

  it('attributes the exact child run and agent across pages, never the latest message', async () => {
    const store = createMemoryStore();
    const scoped = await seed(store);
    const enqueuer = new RecordingEnqueuer();
    const tools = await createExecutionTools({ store: scoped, enqueuer });
    await tools.get('child_spawn')?.execute({ prompt: 'first', targetAgentId: TARGET }, ctxFor(scoped, 'stp-a'));
    await tools.get('child_spawn')?.execute({ prompt: 'second', targetAgentId: TARGET }, ctxFor(scoped, 'stp-b'));
    const children = await listChildTasks(scoped, PARENT);
    expect(children).toHaveLength(2);
    const firstId = String(children[0]?.runId);
    const secondId = String(children[1]?.runId);
    // CT: each child's result is the canonical childResult on its own row. A late chat message
    // must never become the result, so one is seeded after the results and then ignored.
    await scoped.patch('runs', firstId, { childResult: 'first child final' });
    await scoped.patch('runs', secondId, { childResult: 'second child done' });
    await scoped.put('items', messageDoc('noise-last', AGENT, 'latest chat noise', PARENT), { conversationId: CONV });
    const statuses = await listChildTasks(scoped, PARENT);
    const byId = new Map(statuses.map((child) => [child.runId, child] as const));
    expect(byId.get(firstId)?.result).toBe('first child final');
    expect(byId.get(secondId)?.result).toBe('second child done');
  });

  it('lists every child of the parent through the indexed parent link, however many there are', async () => {
    const store = createMemoryStore();
    const scoped = await seed(store);
    for (let i = 0; i < 5100; i += 1) {
      const id = 'run-cap-' + String(i);
      const child: ChildRun = {
        id, agentId: TARGET, conversationId: CONV, parentRunId: PARENT,
        childSessionKey: childSessionKey(TARGET, CONV, id), planId: childPlanId(TARGET, CONV, id),
        title: 'cap ' + String(i), status: 'queued', kind: 'background', steps: [],
        usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
        startedAt: AT, lastActivityAt: AT,
      };
      await scoped.put('runs', child, { agentId: TARGET, conversationId: CONV });
    }
    // The scan this replaced read the owner's whole run history and threw past 50 pages of 100.
    expect(await listChildTasks(scoped, PARENT)).toHaveLength(5100);
  });

  it('validates child_wait ids and carries runIds plus deadline for the core', async () => {
    const store = createMemoryStore();
    const scoped = await seed(store);
    const enqueuer = new RecordingEnqueuer();
    const tools = await createExecutionTools({ store: scoped, enqueuer });
    await tools.get('child_spawn')?.execute({ prompt: 'work', targetAgentId: TARGET }, ctxFor(scoped));
    const foreign = await tools.get('child_wait')?.execute({ runIds: ['run_child_foreign'] }, ctxFor(scoped));
    expect(foreign?.isError).toBe(true);
    expect(foreign?.suspend).toBeUndefined();
    expect((await scoped.list('requests', { limit: 5 })).items).toHaveLength(0);
    const waiting = await tools.get('child_wait')?.execute({ timeoutMs: 5000 }, ctxFor(scoped));
    expect(waiting?.suspend).toMatchObject({ reason: 'child' });
    expect(typeof waiting?.suspend?.until).toBe('string');
    expect(waiting?.details).toMatchObject({ parentRunId: PARENT, timeoutMs: 5000, until: waiting?.suspend?.until });
    expect(Array.isArray((waiting?.details?.['runIds'] ?? undefined))).toBe(true);
    expect((await scoped.list('requests', { limit: 5 })).items).toHaveLength(0);
  });

  it('posts the RunInput keyed by the reserved run id', async () => {
    const store = createMemoryStore();
    await seed(store);
    const reserved = childRunId({ ownerId: OWNER, parentRunId: PARENT, callId: STEP });
    const start: ChildRunStart = { runId: reserved, ownerId: OWNER, agentId: TARGET, conversationId: CONV, sessionKey: childSessionKey(TARGET, CONV, reserved), planId: childPlanId(TARGET, CONV, reserved), parentRunId: PARENT, prompt: 'work', depth: 1 };
    const stub = new RunnerStub();
    await new RunnerEnqueuer(stub.asRunner(), store).startChildRun(start);
    const first = stub.calls[0];
    if (first?.target === undefined) throw new Error('nothing was sent');
    expect(first.target).toMatchObject({ service: 'Run', key: reserved, handler: 'run' });
    expect(first.target.input).toMatchObject({ sessionKey: start.sessionKey, wakeEvents: [{ kind: 'child_task', ownerId: OWNER, hop: { chainId: PARENT, depth: 1 } }] });
  });

  it('makes cancel delivery failures observable and expiring only on success', async () => {
    const store = createMemoryStore();
    const scoped = await seed(store);
    await scoped.put('requests', approvalDoc(), { runId: PARENT });
    const stub = new RunnerStub();
    stub.failWith = new Error('nope');
    await expect(new RunnerEnqueuer(stub.asRunner(), scoped).stopRun(PARENT)).rejects.toThrow(/could not stop run/);
    const still: Request | null = await scoped.get('requests', 'req-1');
    expect(still?.status).toBe('pending');
    stub.failWith = undefined;
    await new RunnerEnqueuer(stub.asRunner(), scoped).stopRun(PARENT);
    const expired: Request | null = await scoped.get('requests', 'req-1');
    expect(expired?.status).toBe('expired');
  });

  it('reports retryable instead of false ok when the delivery-state write fails', async () => {
    const store = createMemoryStore();
    const scoped = await seed(store);
    const flaky = new FlakyEnqueuer();
    const tools = await createExecutionTools({ store: scoped, enqueuer: flaky });
    const first = await tools.get('child_spawn')?.execute({ prompt: 'work', targetAgentId: TARGET }, ctxFor(scoped, STEP));
    const runId = first?.details?.['runId'];
    if (typeof runId !== 'string') throw new Error('retry id missing');
    const failingPatch: Store = { ...scoped, patch: async () => { throw new Error('metadata write failed'); } };
    const failingTools = await createExecutionTools({ store: failingPatch, enqueuer: flaky });
    const retry = await failingTools.get('child_spawn')?.execute({ prompt: 'work', targetAgentId: TARGET, retryRunId: runId }, { ...ctxFor(failingPatch, 'stp-w'), store: failingPatch });
    expect(retry?.isError).toBe(true);
    expect(retry?.details).toMatchObject({ refused: 'dispatch_failed', runId });
    const row: ChildRun | null = await scoped.get('runs', runId);
    expect(row?.dispatch).toBe('pending');
    await expect(markDispatch(failingPatch, runId, { dispatch: 'accepted' })).rejects.toThrow('metadata write failed');
  });

  it('never clobbers a started child when recording delivery', async () => {
    const store = createMemoryStore();
    const scoped = await seed(store);
    const flaky = new FlakyEnqueuer();
    const tools = await createExecutionTools({ store: scoped, enqueuer: flaky });
    const first = await tools.get('child_spawn')?.execute({ prompt: 'work', targetAgentId: TARGET }, ctxFor(scoped, STEP));
    const runId = first?.details?.['runId'];
    if (typeof runId !== 'string') throw new Error('retry id missing');
    const live: ChildRun | null = await scoped.get('runs', runId);
    if (live === null) throw new Error('reserved row missing');
    await scoped.put('runs', { ...live, status: 'running', usage: { ...live.usage, steps: 5 } }, { agentId: TARGET, conversationId: CONV });
    const retry = await tools.get('child_spawn')?.execute({ prompt: 'work', targetAgentId: TARGET, retryRunId: runId }, ctxFor(scoped, 'stp-live'));
    expect(retry?.isError).not.toBe(true);
    const current: ChildRun | null = await scoped.get('runs', runId);
    expect(current?.status).toBe('running');
    expect(current?.usage.steps).toBe(5);
    expect(current?.dispatch).toBe('accepted');
  });
});
